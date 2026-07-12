#!/usr/bin/env node
// M2.4 smoke: drive the MCP server over stdio and verify the resource surface
// (resources/list, resources/read, resources/subscribe, notifications/resources/updated).
//
// Run from host:
//   node scripts/smoke-test-m2-mcp.mjs

import { spawn } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `m2-mcp-${Date.now()}`;

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

async function main() {
  console.log(`# M2.4 MCP-layer smoke (session=${SESSION_ID})`);

  const proc = spawn(
    "docker",
    ["exec", "-i", "lean-chronoscope-mcp", "node", "/app/dist/bin/mcp.js", "--session", SESSION_ID],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  const notifs = [];
  let nextId = 1;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method?.startsWith("notifications/")) {
      notifs.push(msg);
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

  // 1. Initialize.
  console.log("\n[1] initialize");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-m2-4", version: "0.0.0" },
  });
  ok(init.protocolVersion, `protocolVersion=${init.protocolVersion}`);
  ok(init.capabilities?.resources?.subscribe === true, "server advertises resources.subscribe");
  ok(init.capabilities?.tools, "server still advertises tools");
  notify("notifications/initialized");

  // 2. resources/list.
  console.log("\n[2] resources/list");
  const list = await rpc("resources/list", {});
  const uris = list.resources.map((r) => r.uri);
  ok(uris.includes("browser://sessions"), "includes browser://sessions");
  ok(uris.includes("browser://docs/tools"), "includes browser://docs/tools");

  // 3. resources/read browser://docs/tools — rendered on MCP side.
  console.log("\n[3] resources/read browser://docs/tools");
  const docs = await rpc("resources/read", { uri: "browser://docs/tools" });
  ok(docs.contents?.[0]?.mimeType === "application/json", "json mime");
  const parsedDocs = JSON.parse(docs.contents[0].text);
  ok(typeof parsedDocs.count === "number" && parsedDocs.count > 0, `count=${parsedDocs.count}`);
  ok(parsedDocs.tools?.some((t) => t.name === "page_navigate"), "page_navigate present");

  // 4. resources/subscribe browser://session/<sid>/pages, then trigger a page.
  const subUri = `browser://session/${SESSION_ID}/pages`;
  console.log(`\n[4] resources/subscribe ${subUri}`);
  await rpc("resources/subscribe", { uri: subUri });
  ok(true, "subscribe returned");

  // 5. Use the page_navigate tool — it'll session.ensure + page.new + navigate
  //    → daemon emits browser://session/<sid>/pages → MCP translates.
  console.log("\n[5] tools/call page_navigate about:blank");
  await rpc("tools/call", {
    name: "page_navigate",
    arguments: { url: "about:blank" },
  });
  await waitFor(() => notifs.some((n) => n.params?.uri === subUri));
  const hits = notifs.filter((n) => n.method === "notifications/resources/updated" && n.params?.uri === subUri);
  ok(hits.length > 0, `notifications/resources/updated received (${hits.length})`);
  // New page → set of available resource URIs grew (5 page-scoped URIs added).
  // Server must tell the client to re-list.
  const listChanged = notifs.filter((n) => n.method === "notifications/resources/list_changed");
  ok(listChanged.length > 0, `notifications/resources/list_changed received (${listChanged.length})`);

  // 6. resources/read browser://session/<sid>/pages — should round-trip to daemon.
  console.log(`\n[6] resources/read ${subUri}`);
  const pagesRead = await rpc("resources/read", { uri: subUri });
  const pagesBody = JSON.parse(pagesRead.contents[0].text);
  ok(Array.isArray(pagesBody.data), "data is array");
  ok(pagesBody.data.length >= 1, `page count=${pagesBody.data.length}`);
  ok(typeof pagesBody.revision === "number", `revision=${pagesBody.revision}`);

  // 7. resources/unsubscribe.
  console.log("\n[7] resources/unsubscribe");
  await rpc("resources/unsubscribe", { uri: subUri });
  ok(true, "unsubscribe returned");

  proc.stdin.end();
  // `docker exec -i` doesn't propagate EOF to the child node process,
  // so the MCP server keeps reading and we'd hang. Kill it.
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("close", r));
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
