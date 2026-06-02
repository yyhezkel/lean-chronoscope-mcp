#!/usr/bin/env node
// M1 smoke test: navigate → snapshot → click → console_list → network_list.
// Uses MCP over docker exec stdio.

import { spawn } from "node:child_process";
import readline from "node:readline";

const sessionId = process.env.SMOKE_SESSION ?? "m1-smoke";

const proc = spawn(
  "docker",
  ["exec", "-i", "browser-mcp", "node", "/app/dist/bin/mcp.js", "--session", sessionId],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else resolve(msg.result);
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function call(name, args) {
  return rpc("tools/call", { name, arguments: args });
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-m1", version: "0" },
  });
  const tools = await rpc("tools/list", {});
  console.log(`[1/6] tools loaded (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(", ")}`);

  console.log(`[2/6] navigate → https://example.com`);
  const nav = await call("page_navigate", { url: "https://example.com" });
  console.log("    " + (nav.content[0]?.text ?? "").split("\n").slice(0, 2).join(" | "));

  console.log(`[3/6] snapshot_take`);
  const snap = await call("snapshot_take", {});
  const snapText = snap.content[0]?.text ?? "";
  const uidMatch = snapText.match(/\[(e\d+)\]\s*link/);
  const firstLink = uidMatch ? uidMatch[1] : null;
  console.log("    " + snapText.split("\n").slice(0, 4).map((s) => s.slice(0, 80)).join("\n    "));
  console.log("    first link uid:", firstLink);

  if (firstLink) {
    console.log(`[4/6] click ${firstLink}`);
    const clickRes = await call("click", { uid: firstLink });
    console.log("    " + (clickRes.content[0]?.text ?? "").split("\n").slice(0, 3).join(" | "));
  } else {
    console.log("[4/6] click: skipped (no link in snapshot)");
  }

  console.log(`[5/6] console_list (current nav of current page)`);
  const consoleRes = await call("console_list", { pageSize: 10 });
  const consoleText = consoleRes.content[0]?.text ?? "";
  console.log("    " + consoleText.split("\n").slice(0, 5).join("\n    "));

  console.log(`[6/6] network_list (current nav)`);
  const networkRes = await call("network_list", { pageSize: 20 });
  const netText = networkRes.content[0]?.text ?? "";
  console.log("    " + netText.split("\n").slice(0, 8).join("\n    "));
  const sc = networkRes.structuredContent;
  console.log(`    total requests captured: ${sc?.total}`);

  if (sc?.total > 0 && sc?.rows?.[0]?.id) {
    console.log(`[bonus] network_get reqid=${sc.rows[0].id} part=meta`);
    const detail = await call("network_get", { reqid: sc.rows[0].id, part: "meta" });
    const detailText = detail.content[0]?.text ?? "";
    console.log("    " + detailText.split("\n").slice(0, 6).join("\n    "));
  }

  console.log("\n✅ M1 smoke test passed");
  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ smoke test failed:", err.message);
  proc.kill();
  process.exit(1);
});
