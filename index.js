import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { auth as googleAuth, drive as googleDrive } from "@googleapis/drive";

const PROMPT = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
const PARAMETER_PATH = "/competitor-briefing/";
const REQUIRED_SETTINGS = ["ANTHROPIC_API_KEY", "GOOGLE_SA_JSON", "GDRIVE_FOLDER_ID"];

export async function loadSettings() {
  const missingSettings = REQUIRED_SETTINGS.filter((name) => !process.env[name]);
  if (missingSettings.length === 0) return;

  const { SSMClient, GetParametersCommand } = await import("@aws-sdk/client-ssm");
  const { Parameters, InvalidParameters } = await new SSMClient().send(
    new GetParametersCommand({
      Names: missingSettings.map((name) => PARAMETER_PATH + name),
      WithDecryption: true,
    })
  );
  if (InvalidParameters.length > 0) throw new Error(`Not found in Parameter Store: ${InvalidParameters.join(", ")}`);

  for (const parameter of Parameters) {
    process.env[parameter.Name.slice(PARAMETER_PATH.length)] = parameter.Value;
  }
}

export const dateLabel = (d = new Date()) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

export function nextTitle(base, existingNames) {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

// The brief is the text after the last tool block; earlier text is the model narrating its searches.
export function extractBrief(content) {
  const lastTool = content.findLastIndex((b) => b.type !== "text" && b.type !== "thinking");
  return content
    .slice(lastTool + 1)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/^\s*```(?:html)?\s*|\s*```\s*$/g, "")
    .trim();
}

export async function research(today = dateLabel()) {
  await loadSettings();
  const client = new Anthropic();
  const messages = [{ role: "user", content: `Run today's competitor brief. Today is ${today}.` }];
  const usage = {};
  // A long server-side tool turn comes back as pause_turn and is resumed by resending.
  for (let turn = 0; turn < 8; turn++) {
    const message = await client.beta.messages
      .stream({
        model: process.env.BRIEF_MODEL ?? "claude-opus-5-5",
        max_tokens: 32000,
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: PROMPT,
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 60 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 25, max_content_tokens: 15000 },
        ],
        messages,
      })
      .finalMessage();

    for (const [k, v] of Object.entries(message.usage)) if (typeof v === "number") usage[k] = (usage[k] ?? 0) + v;
    const tools = message.usage.server_tool_use;
    console.log(`claude: turn ${turn + 1} stop=${message.stop_reason} searches=${tools?.web_search_requests ?? 0} fetches=${tools?.web_fetch_requests ?? 0}`);

    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    console.log(`claude: ${message.model} usage ${JSON.stringify(usage)}`);
    if (message.stop_reason !== "end_turn") throw new Error(`Claude stopped with ${message.stop_reason}; no usable brief`);
    const html = extractBrief(message.content);
    if (!html.includes("<h1")) throw new Error(`Claude's final message is not the HTML brief: ${html.slice(0, 200)}`);
    return html;
  }
  throw new Error("Claude was still paused after 8 turns");
}

export async function saveDoc(baseTitle, html) {
  await loadSettings();
  const auth = new googleAuth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SA_JSON),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const drive = googleDrive({ version: "v3", auth });
  const folder = process.env.GDRIVE_FOLDER_ID;
  const { data: list } = await drive.files.list({
    q: `'${folder}' in parents and trashed = false and name contains '${baseTitle.replace(/'/g, "\\'")}'`,
    fields: "files(name)",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const name = nextTitle(baseTitle, (list.files ?? []).map((f) => f.name));
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folder], mimeType: "application/vnd.google-apps.document" },
    media: { mimeType: "text/html", body: html },
    supportsAllDrives: true,
    fields: "id, name, webViewLink",
  });
  console.log(`drive: created "${data.name}" ${data.webViewLink}`);
  return data;
}

export async function handler() {
  const today = dateLabel();
  const html = await research(today);
  const doc = await saveDoc(`Tempest Competitor Brief — ${today}`, html);
  return { title: doc.name, url: doc.webViewLink };
}
