#!/usr/bin/env node
// Token/context benchmark for lean-chronoscope-mcp. Runs a representative task against
// the live daemon and reports the model-visible output size (chars + ~chars/4
// token estimate) per tool call, plus the fixed tool-schema mount overhead.
//
//   node scripts/bench-tokens.mjs [url]
//
// The Playwright-MCP side is captured separately (see docs/COMPARISON.md) because
// it runs in its own browser namespace; rerun it via the native MCP client when
// that server is available and drop the numbers into the doc.
import { spawnMcp } from "./tools/harness.mjs";

const URL = process.argv[2] ?? "https://news.ycombinator.com/";
const tok = (s) => Math.round(s.length / 4); // ~4 chars/token (English+structured)

const mcp = spawnMcp(`bench-${Date.now()}`);
const { callTool, txt } = mcp;
await mcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
mcp.notify("notifications/initialized");

const tools = (await mcp.rpc("tools/list", {})).tools;
const schemaChars = JSON.stringify(tools).length;

const rows = [];
const run = async (label, name, args) => {
  const t = txt(await callTool(name, args));
  rows.push([label, t.length, tok(t)]);
};

await run("navigate", "page_navigate", { url: URL, waitUntil: "load" });
await run("snapshot_take", "snapshot_take", {});
await run("console_list", "console_list", {});
await run("network_list", "network_list", {});

await callTool("session_close", {});
await mcp.close();

console.log(`\n# lean-chronoscope-mcp token benchmark — ${URL}\n`);
console.log(`Mount overhead: ${tools.length} tools, ${schemaChars} chars (~${tok(JSON.stringify(tools))} tok)\n`);
console.log("Call            chars     ~tokens");
let total = 0;
for (const [l, c, t] of rows) {
  total += t;
  console.log(`  ${l.padEnd(14)} ${String(c).padStart(6)}   ~${t}`);
}
console.log(`  ${"TASK TOTAL".padEnd(14)} ${"".padStart(6)}   ~${total} tok`);
