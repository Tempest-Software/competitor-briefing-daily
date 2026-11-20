// npm test         -> offline checks of the title and extraction logic
// npm run brief    -> real Claude run, prints the HTML brief, no Drive upload (about $1)
// npm run upload   -> real run plus Drive upload (needs GOOGLE_SA_JSON and GDRIVE_FOLDER_ID in .env)
import assert from "node:assert/strict";
import { nextTitle, extractBrief, research, handler } from "./index.js";

const mode = process.argv[2];
if (mode === "brief") {
  console.log(await research());
} else if (mode === "upload") {
  console.log(await handler());
} else {
  const base = "Tempest Competitor Brief — July 8, 2026";
  assert.equal(nextTitle(base, []), base);
  assert.equal(nextTitle(base, [base]), `${base} (2)`);
  assert.equal(nextTitle(base, [base, `${base} (2)`, `${base} (4)`]), `${base} (3)`);
  assert.equal(nextTitle(base, [`${base} (2)`]), base);
  assert.equal(
    extractBrief([
      { type: "text", text: "Searching..." },
      { type: "server_tool_use" },
      { type: "web_search_tool_result" },
      { type: "thinking", thinking: "" },
      { type: "text", text: "```html\n<h1>T</h1>" },
      { type: "text", text: "<p>x</p>\n```" },
    ]),
    "<h1>T</h1><p>x</p>"
  );
  console.log("ok");
}
