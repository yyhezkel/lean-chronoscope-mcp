#!/usr/bin/env node
// v1.1 smoke: script_evaluate + page lifecycle + session lifecycle + wait_for
// + network_wait_for. End-to-end over stdio MCP against the running container.

import { spawn } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `v11-${Date.now()}`;

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function main() {
  console.log(`# v1.1 smoke (session=${SESSION_ID})`);
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

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-v11", version: "0.0.0" },
  });
  notify("notifications/initialized");

  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  for (const n of ["script_evaluate", "page_list", "page_new", "page_select", "page_close", "page_back", "page_forward", "page_reload", "session_list", "session_new", "session_close", "wait_for", "network_wait_for", "upload_file"]) {
    ok(names.includes(n), `${n} registered`);
  }

  // ---- script_evaluate ----
  console.log("\n[script_evaluate]");
  await callTool("page_navigate", { url: "https://example.com/" });
  const ev = sc(await callTool("script_evaluate", { expression: "1 + 2 * 3" }));
  ok(ev.value === 7, `eval 1+2*3 = ${ev.value}`);
  const ev2 = sc(await callTool("script_evaluate", { expression: "return document.title" }));
  ok(typeof ev2.value === "string" && ev2.value.length > 0, `document.title = ${ev2.value}`);

  // ---- page lifecycle ----
  console.log("\n[page lifecycle]");
  const newPage = sc(await callTool("page_new", { url: "https://example.org/", background: true }));
  ok(typeof newPage.pageId === "string", `page_new -> ${newPage.pageId}`);
  const list = sc(await callTool("page_list", {}));
  ok(list.pages.length >= 2, `page_list shows ${list.pages.length} pages`);
  const sel = sc(await callTool("page_select", { pageId: newPage.pageId }));
  ok(sel.pageId === newPage.pageId, "page_select switched");
  const reload = sc(await callTool("page_reload", {}));
  ok(reload.pageId === newPage.pageId, "page_reload ok");
  const closed = sc(await callTool("page_close", { pageId: newPage.pageId }));
  ok(closed.closedPageId === newPage.pageId, "page_close ok");

  // ---- wait_for ----
  console.log("\n[wait_for]");
  await callTool("page_navigate", {
    url: "data:text/html," + encodeURIComponent(`<div id=x>loading</div><script>setTimeout(()=>{document.getElementById('x').textContent='READY_TOKEN';},400)</script>`),
  });
  const w = sc(await callTool("wait_for", { text: "READY_TOKEN", timeoutMs: 5000 }));
  ok(w.matched === true, `wait_for matched in ${w.waitedMs}ms`);

  // ---- network_wait_for ----
  console.log("\n[network_wait_for]");
  // The navigation itself issues a document request — wait_for should find it
  // (covers the "already-completed request" path; polling also covers in-flight).
  await callTool("page_navigate", { url: "https://example.com/?probe=netwait" });
  const nw = sc(await callTool("network_wait_for", { urlContains: "probe=netwait", timeoutMs: 6000 }));
  ok(nw.matched === true, `network_wait_for matched (${nw.request?.url}) in ${nw.waitedMs}ms`);

  // ---- session lifecycle ----
  console.log("\n[session lifecycle]");
  const sl = sc(await callTool("session_list", {}));
  ok(Array.isArray(sl.sessions) && sl.sessions.some((s) => s.id === SESSION_ID), "session_list includes us");
  // Close a throwaway session (not our own, so the connection stays valid).
  const throwaway = `${SESSION_ID}-tmp`;
  await rpc("tools/call", { name: "session_new", arguments: {} }); // ensures our own; harmless
  // Use the daemon directly via a second ensure through page_new on a tmp id is not possible
  // from this connection (sessionId is fixed), so just close a non-existent id to exercise the path.
  const sclose = sc(await callTool("session_close", { sessionId: throwaway }));
  ok(sclose.closed === false, "session_close of unknown id returns closed=false");

  proc.stdin.end();
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("close", r));
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
