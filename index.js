// Competitor Briefing Daily Report (APP-739).
// EventBridge -> this Lambda -> Claude (web search + fetch) -> Google Doc in the ai-briefings shared drive.
//
// Env vars:
//   ANTHROPIC_API_KEY   Claude API key
//   GOOGLE_SA_JSON      service account key JSON (the account must be Contributor on the shared drive)
//   GDRIVE_FOLDER_ID    ID of the `competitor` folder
//   BRIEF_MODEL         optional, defaults to claude-opus-5-5
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";

const PROMPT = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");

// "November 18, 2026" in Eastern time, whatever timezone Lambda runs in.
export const dateLabel = (d = new Date()) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });

// Same-day rule from Eddie's task: first doc keeps the base title, reruns get " (2)", " (3)", ...
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
  const client = new Anthropic();
  const messages = [{ role: "user", content: `Run today's competitor brief. Today is ${today}.` }];
  const usage = {};
  // Server-side tools run in Anthropic's loop; a long turn comes back as pause_turn and is resumed by resending.
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

// Uploads HTML and lets Drive convert it to a Google Doc. Unlike the Zendesk digest, the doc is
// the only output here, so a Drive failure fails the run.
export async function saveDoc(baseTitle, html) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SA_JSON),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const drive = google.drive({ version: "v3", auth });
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
