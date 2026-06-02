#!/usr/bin/env node
// M2.5 smoke: verify change-detect collapses repeated identical sections
// in the console_list response, and that migration 002 (resource_revisions)
// was applied to the new session DB.

import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `m2-changes-${Date.now()}`;

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function main() {
  console.log(`# M2.5 change-detect smoke (session=${SESSION_ID})`);

  const proc = spawn(
    "docker",
    ["exec", "-i", "browser-mcp", "node", "/app/dist/bin/mcp.js", "--session", SESSION_ID],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    }
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-m2-5", version: "0.0.0" },
  });
  notify("notifications/initialized");

  // Create page so console_list has a target.
  await rpc("tools/call", { name: "page_navigate", arguments: { url: "about:blank" } });

  // 1) First console_list — empty, should be full section.
  console.log("\n[1] console_list (empty)");
  const c1 = await rpc("tools/call", { name: "console_list", arguments: {} });
  const text1 = c1.content[0].text;
  ok(
    text1.includes("### Console\n(no messages)"),
    "first render shows full '### Console' + body",
  );

  // 2) Repeat — body unchanged → should collapse.
  console.log("\n[2] console_list (identical, should collapse)");
  const c2 = await rpc("tools/call", { name: "console_list", arguments: {} });
  const text2 = c2.content[0].text;
  ok(
    /### Console \(unchanged since rev \d+\)/.test(text2),
    `second render collapses: ${text2.split("\n")[0]}`,
  );
  ok(!text2.includes("(no messages)"), "no full body emitted on collapse");

  // 3) Trigger a console.log then list — body changes → full render again.
  console.log("\n[3] page.evaluate(console.log) + console_list");
  await rpc("tools/call", {
    name: "page_navigate",
    arguments: { url: "about:blank" },  // any tool; we'll use script_eval workaround
  });
  // Use a daemon-direct page.evaluate via the same MCP — we don't have a script_evaluate tool
  // yet (lands in M2 plan), but page.evaluate is exposed as the MCP `page_navigate` only.
  // Trigger via a navigation that loads a data URL with inline console.log:
  await rpc("tools/call", {
    name: "page_navigate",
    arguments: { url: "data:text/html,<script>console.log('m2.5 ping')</script>" },
  });
  await new Promise((r) => setTimeout(r, 300));
  const c3 = await rpc("tools/call", { name: "console_list", arguments: {} });
  const text3 = c3.content[0].text;
  ok(
    text3.includes("m2.5 ping") || text3.includes("### Console\n"),
    `third render is full again (text starts: ${text3.slice(0, 80)})`,
  );

  // 4) Verify migration 002 created the resource_revisions table.
  console.log("\n[4] migration 002 applied (resource_revisions table)");
  const dbPath = `/var/lib/browser-mcp/sessions/${SESSION_ID}/db.sqlite`;
  const script = `const D=require('better-sqlite3');const db=D(${JSON.stringify(dbPath)},{readonly:true});const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();console.log(JSON.stringify(rows.map(r=>r.name)));`;
  const dbq = spawnSync(
    "docker",
    ["exec", "-w", "/app", "browser-mcp", "node", "-e", script],
    { encoding: "utf8" },
  );
  const stdout = (dbq.stdout || "").trim();
  const stderr = (dbq.stderr || "").trim();
  let tables = [];
  try { tables = JSON.parse(stdout); } catch { /* keep [] */ }
  ok(
    tables.includes("resource_revisions"),
    `tables include resource_revisions: [${tables.join(",")}]${stderr ? ` stderr=${stderr.slice(0, 200)}` : ""}`,
  );

  proc.stdin.end();
  // `docker exec -i` doesn't propagate EOF to the child node process,
  // so the MCP server keeps reading and we'd hang. Kill it.
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("close", r));
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
