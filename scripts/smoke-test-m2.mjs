#!/usr/bin/env node
// M2.2 smoke test: open the daemon Unix socket directly, exercise
// resources.list / resources.subscribe / resources.read, then trigger a
// session/page lifecycle event and assert a `resource.updated` notification
// arrives via the same socket.
//
// Run inside the container:
//   docker exec -i lean-chronoscope-mcp node /app/scripts/smoke-test-m2.mjs
// or from outside (mounting via host fs):
//   docker exec -i lean-chronoscope-mcp node - < scripts/smoke-test-m2.mjs

import net from "node:net";
import readline from "node:readline";

const SOCKET_PATH = process.env.LEAN_CHRONOSCOPE_SOCKET ?? "/run/lean-chronoscope/daemon.sock";
const SESSION_ID = process.env.SMOKE_SESSION ?? "m2-smoke";

function connect(path) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path }, () => resolve(sock));
    sock.on("error", reject);
  });
}

function rpc(sock, pending, method, params) {
  return new Promise((resolve, reject) => {
    const id = pending.nextId++;
    pending.map.set(id, { resolve, reject, method });
    const msg = { jsonrpc: "2.0", id, method, params };
    sock.write(JSON.stringify(msg) + "\n");
  });
}

function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`# M2 smoke (socket=${SOCKET_PATH}, session=${SESSION_ID})`);

  const sock = await connect(SOCKET_PATH);
  const pending = { nextId: 1, map: new Map() };
  const notifications = [];

  const rl = readline.createInterface({ input: sock, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.map.has(msg.id)) {
      const { resolve, reject } = pending.map.get(msg.id);
      pending.map.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      notifications.push(msg);
    }
  });

  // 1. Ensure session.
  console.log("\n[1] session.ensure");
  const ensure = await rpc(sock, pending, "session.ensure", { sessionId: SESSION_ID });
  ok(ensure.sessionId === SESSION_ID, `sessionId=${ensure.sessionId}`);

  // 2. resources.list should include browser://sessions and our session's pages URI.
  console.log("\n[2] resources.list");
  const list = await rpc(sock, pending, "resources.list", {});
  const uris = list.resources.map((r) => r.uri);
  ok(uris.includes("browser://sessions"), "includes browser://sessions");
  ok(uris.includes(`browser://session/${SESSION_ID}/pages`), `includes session.pages URI`);

  // 3. Subscribe to browser://sessions.
  console.log("\n[3] resources.subscribe browser://sessions");
  const sub = await rpc(sock, pending, "resources.subscribe", { uri: "browser://sessions" });
  ok(typeof sub.revision === "number", `subscribe ok, revision=${sub.revision}`);

  // 4. Trigger a fresh session creation in a different session id → broadcaster emits browser://sessions.
  console.log("\n[4] trigger lifecycle event (new session)");
  const otherSession = `${SESSION_ID}-other-${Date.now()}`;
  await rpc(sock, pending, "session.ensure", { sessionId: otherSession });

  // Wait up to 1s for the debounced notification (200ms debounce window).
  const start = Date.now();
  while (Date.now() - start < 1000 && notifications.length === 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(notifications.length > 0, `notification received (count=${notifications.length})`);
  if (notifications[0]) {
    ok(notifications[0].method === "resource.updated", `method=${notifications[0].method}`);
    ok(
      notifications[0].params?.uri === "browser://sessions",
      `params.uri=${notifications[0].params?.uri}`,
    );
    ok(
      typeof notifications[0].params?.revision === "number",
      `revision present (${notifications[0].params?.revision})`,
    );
  }

  // 5. resources.read browser://sessions returns both sessions.
  console.log("\n[5] resources.read browser://sessions");
  const read = await rpc(sock, pending, "resources.read", { uri: "browser://sessions" });
  ok(Array.isArray(read.data), "data is array");
  const ids = read.data.map((s) => s.id);
  ok(ids.includes(SESSION_ID) && ids.includes(otherSession), `both sessions present: ${ids.join(",")}`);

  // 6. resources.unsubscribe.
  console.log("\n[6] resources.unsubscribe");
  const unsub = await rpc(sock, pending, "resources.unsubscribe", { uri: "browser://sessions" });
  ok(unsub.removed === true, "removed=true");

  // 7. After unsubscribe, new emits must NOT reach this socket.
  console.log("\n[7] post-unsubscribe lifecycle event yields no notification");
  notifications.length = 0;
  await rpc(sock, pending, "session.ensure", { sessionId: `${SESSION_ID}-third-${Date.now()}` });
  await new Promise((r) => setTimeout(r, 400));
  ok(notifications.length === 0, `silent (count=${notifications.length})`);

  sock.end();
  console.log("\n# done");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
