#!/usr/bin/env node
// M2.3 smoke: verify collectors broadcast on console/network/snapshot/url after writes.
// Run inside container:
//   docker exec -i lean-chronoscope-mcp node /tmp/smoke-test-m2-collectors.mjs

import net from "node:net";
import readline from "node:readline";

const SOCKET_PATH = process.env.LEAN_CHRONOSCOPE_SOCKET ?? "/run/lean-chronoscope/daemon.sock";
const SESSION_ID = process.env.SMOKE_SESSION ?? `m2-collectors-${Date.now()}`;

function connect(path) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path }, () => resolve(sock));
    sock.on("error", reject);
  });
}

function rpc(sock, pending, method, params) {
  return new Promise((resolve, reject) => {
    const id = pending.nextId++;
    pending.map.set(id, { resolve, reject });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

async function main() {
  console.log(`# M2.3 collectors smoke (session=${SESSION_ID})`);

  const sock = await connect(SOCKET_PATH);
  const pending = { nextId: 1, map: new Map() };
  const notifs = [];

  readline.createInterface({ input: sock, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.map.has(msg.id)) {
      const { resolve, reject } = pending.map.get(msg.id);
      pending.map.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method === "resource.updated") {
      notifs.push(msg.params);
    }
  });

  // Setup: session + page.
  console.log("\n[setup] session + about:blank page");
  await rpc(sock, pending, "session.ensure", { sessionId: SESSION_ID });
  const pn = await rpc(sock, pending, "page.new", { sessionId: SESSION_ID, url: "about:blank" });
  const pageId = pn.pageId;
  ok(typeof pageId === "string", `pageId=${pageId}`);

  const consoleUri = `browser://session/${SESSION_ID}/page/${pageId}/console/live`;
  const networkUri = `browser://session/${SESSION_ID}/page/${pageId}/network/live`;
  const snapshotUri = `browser://session/${SESSION_ID}/page/${pageId}/snapshot/latest`;
  const urlUri = `browser://session/${SESSION_ID}/page/${pageId}/url`;

  // Subscribe to all four.
  console.log("\n[subscribe] console / network / snapshot / url");
  for (const uri of [consoleUri, networkUri, snapshotUri, urlUri]) {
    await rpc(sock, pending, "resources.subscribe", { uri });
  }

  // --- Console: trigger via page.evaluate(console.log) ---
  console.log("\n[console] page.evaluate('console.log(...)')");
  notifs.length = 0;
  await rpc(sock, pending, "page.evaluate", {
    sessionId: SESSION_ID,
    pageId,
    expression: "console.log('m2.3 console ping', 1, 2, 3)",
  });
  await waitFor(() => notifs.some((n) => n.uri === consoleUri));
  const consoleHits = notifs.filter((n) => n.uri === consoleUri);
  ok(consoleHits.length > 0, `console notifications received (${consoleHits.length})`);
  ok(
    consoleHits[0]?.preview?.kind === "console",
    `preview.kind=${consoleHits[0]?.preview?.kind}`,
  );
  ok(
    typeof consoleHits[0]?.preview?.lastId === "number",
    `preview.lastId present (${consoleHits[0]?.preview?.lastId})`,
  );

  // --- Network: trigger via fetch from page context ---
  console.log("\n[network] page.evaluate('fetch(data:url)')");
  notifs.length = 0;
  await rpc(sock, pending, "page.evaluate", {
    sessionId: SESSION_ID,
    pageId,
    expression: "fetch('data:text/plain,hello').then(r=>r.text())",
    awaitPromise: true,
  });
  await waitFor(() => notifs.some((n) => n.uri === networkUri));
  const networkHits = notifs.filter((n) => n.uri === networkUri);
  ok(networkHits.length > 0, `network notifications received (${networkHits.length})`);
  ok(
    networkHits[0]?.preview?.kind?.startsWith("network."),
    `preview.kind=${networkHits[0]?.preview?.kind}`,
  );

  // --- Snapshot: trigger via snapshot.take ---
  console.log("\n[snapshot] snapshot.take");
  notifs.length = 0;
  await rpc(sock, pending, "snapshot.take", { sessionId: SESSION_ID, pageId });
  await waitFor(() => notifs.some((n) => n.uri === snapshotUri));
  const snapHits = notifs.filter((n) => n.uri === snapshotUri);
  ok(snapHits.length > 0, `snapshot notifications received (${snapHits.length})`);
  ok(snapHits[0]?.preview?.kind === "snapshot", `preview.kind=${snapHits[0]?.preview?.kind}`);

  // --- URL: trigger via page.navigate (framenavigated) ---
  console.log("\n[url] page.navigate(about:blank?nav=2)");
  notifs.length = 0;
  await rpc(sock, pending, "page.navigate", {
    sessionId: SESSION_ID,
    pageId,
    url: "about:blank?nav=2",
  });
  await waitFor(() => notifs.some((n) => n.uri === urlUri));
  const urlHits = notifs.filter((n) => n.uri === urlUri);
  ok(urlHits.length > 0, `url notifications received (${urlHits.length})`);

  // --- Coalescing: many emits → one notification per debounce window ---
  console.log("\n[coalesce] 5× console.log → 1 debounced notification");
  notifs.length = 0;
  for (let i = 0; i < 5; i++) {
    await rpc(sock, pending, "page.evaluate", {
      sessionId: SESSION_ID,
      pageId,
      expression: `console.log('burst', ${i})`,
    });
  }
  await new Promise((r) => setTimeout(r, 400));
  const burstHits = notifs.filter((n) => n.uri === consoleUri);
  ok(
    burstHits.length === 1,
    `coalesced to 1 (got ${burstHits.length})`,
  );

  sock.end();
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
