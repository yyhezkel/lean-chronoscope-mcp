#!/usr/bin/env node
// M5+M6 smoke: snapshot_diff + performance_metrics + console/network search (FTS5)
// + daemon_status. End-to-end over stdio MCP against the running container.

import { spawn } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `m5m6-${Date.now()}`;

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function main() {
  console.log(`# M5+M6 smoke (session=${SESSION_ID})`);

  const proc = spawn(
    "docker",
    ["exec", "-i", "lean-chronoscope-mcp", "node", "/app/dist/bin/mcp.js", "--session", SESSION_ID],
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
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params = {}) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
  const sc = (r) => r.structuredContent ?? {};
  const txt = (r) => (r.content.find((c) => c.type === "text")?.text ?? "");

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-m5m6", version: "0.0.0" },
  });
  notify("notifications/initialized");

  // Tool surface should now be the full v1 set.
  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  ok(names.includes("snapshot_diff"), "snapshot_diff registered");
  ok(names.includes("performance_metrics"), "performance_metrics registered");
  ok(names.includes("console_search"), "console_search registered");
  ok(names.includes("network_search"), "network_search registered");
  ok(names.includes("daemon_status"), "daemon_status registered");

  // ---- M5.1 snapshot_diff ----
  console.log("\n[M5.1] snapshot_diff");
  await callTool("page_navigate", {
    url: "data:text/html," + encodeURIComponent(`<button id="b">One</button>`),
  });
  const snap1 = sc(await callTool("snapshot_take", {}));
  ok(typeof snap1.snapshotId === "number", `snapshot 1 id=${snap1.snapshotId}`);
  await callTool("page_navigate", {
    url: "data:text/html," + encodeURIComponent(`<button id="b">Two</button><a href="#">link</a>`),
  });
  const snap2 = sc(await callTool("snapshot_take", {}));
  ok(typeof snap2.snapshotId === "number", `snapshot 2 id=${snap2.snapshotId}`);
  const diff = sc(await callTool("snapshot_diff", {}));
  ok(
    diff.addedUids + diff.removedUids + diff.changedUids > 0,
    `diff detected changes (added=${diff.addedUids} removed=${diff.removedUids} changed=${diff.changedUids})`,
  );

  // ---- M5.3 performance_metrics ----
  console.log("\n[M5.3] performance_metrics");
  await callTool("page_navigate", { url: "https://example.com/" });
  const perf = sc(await callTool("performance_metrics", {}));
  ok(perf.metrics && typeof perf.metrics.Nodes === "number", `Nodes metric present (${perf.metrics?.Nodes})`);
  ok("JSHeapUsedSize" in (perf.metrics ?? {}), "JS heap metric present");

  // ---- M5.4 FTS5 search ----
  console.log("\n[M5.4] FTS5 search");
  await callTool("page_navigate", {
    url:
      "data:text/html," +
      encodeURIComponent(`<script>console.log("uniquetoken_alpha happened"); console.error("uniquetoken_beta failed");</script>`),
  });
  await new Promise((r) => setTimeout(r, 300));
  const cs = sc(await callTool("console_search", { query: "uniquetoken_alpha" }));
  ok(cs.total >= 1, `console_search found uniquetoken_alpha (total=${cs.total})`);
  const ns = sc(await callTool("network_search", { query: "example.com" }));
  ok(ns.total >= 1, `network_search found example.com (total=${ns.total})`);

  // ---- M6.2 daemon_status ----
  console.log("\n[M6.2] daemon_status");
  const st = sc(await callTool("daemon_status", {}));
  ok(/^\d+\.\d+\.\d+$/.test(st.version), `version=${st.version}`);
  ok(st.browserConnected === true, "browser connected");
  ok(Array.isArray(st.sessions) && st.sessions.some((s) => s.id === SESSION_ID), "our session listed");

  // ---- M4.4 screenshot rescaling ----
  console.log("\n[M4.4] screenshot rescale");
  await callTool("emulate_viewport", { width: 3000, height: 2000 });
  const shot = sc(await callTool("screenshot_take", { format: "jpeg" }));
  ok(Math.max(shot.width, shot.height) <= 1568, `screenshot long side capped (${shot.width}x${shot.height})`);

  proc.stdin.end();
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("close", r));
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
