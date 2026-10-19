#!/usr/bin/env node
// HTTP-bridge hardening smoke, over real HTTP(S) against a running bridge:
//   /health 200 · bad token 401 · initialize + tools/list · body > cap → 413
//   (declared Content-Length and chunked) · rate limits in separate buckets:
//   per-session burst → 429 without affecting another session; bad-token burst
//   → 429 per IP while a live session keeps working (new initialize is
//   refused until the IP refills). Shared screencast subscription: two HTTP
//   clients pinned to one daemon session (x-lc-session) subscribe to the same
//   screencast URI; A unsubscribes → B still gets updates; B disconnects
//   (DELETE) without unsubscribing → daemon logs "screencast stopped".
// TLS mode (URL starts with https://): same checks with rejectUnauthorized:false,
// plus "plain http:// to the same port fails".
//
// Env: LC_HTTP_URL (default http://127.0.0.1:18803), LC_HTTP_TOKEN (default
// test-token), LC_MAX_BODY (default 4 MiB, must match the bridge),
// LC_RATE_PER_MIN (bridge's HTTP_RATE_PER_MIN; burst check skipped when 0),
// LC_MAX_SESSIONS (bridge's HTTP_MAX_SESSIONS; when set, fills the cap and
// expects 503 on the next initialize), LC_SESSION_RATE_PER_MIN (bridge's
// HTTP_SESSION_RATE_PER_MIN, default 600; 0 skips), LC_CONTAINER (when set,
// the screencast check also greps the daemon log via `docker exec`).
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";

const BASE = (process.env.LC_HTTP_URL ?? "http://127.0.0.1:18803").replace(/\/$/, "");
const TOKEN = process.env.LC_HTTP_TOKEN ?? "test-token";
const MAX_BODY = Number(process.env.LC_MAX_BODY ?? 4 * 1024 * 1024);
const RATE = Number(process.env.LC_RATE_PER_MIN ?? 60);
const MAX_SESSIONS = Number(process.env.LC_MAX_SESSIONS ?? 0);
const SESSION_RATE = Number(process.env.LC_SESSION_RATE_PER_MIN ?? 600);
const CONTAINER = process.env.LC_CONTAINER;
const TLS = BASE.startsWith("https:");

const ok = (c, l) => { if (c) console.log(`  ✓ ${l}`); else { console.log(`  ✗ ${l}`); process.exitCode = 1; } };

/** Minimal request helper. `body` may be a string/Buffer, or {chunks:[...]} for chunked upload. */
function request(url, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let early; // response seen before a write error (server rejected mid-upload)
    const req = mod.request(u, { method, headers, rejectUnauthorized: false }, (res) => {
      early = { status: res.statusCode, headers: res.headers, text: "" };
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString("utf8") }));
      res.on("error", (err) => (early ? resolve(early) : reject(err)));
    });
    req.on("error", (err) => (early ? resolve(early) : reject(err)));
    if (body && body.chunks) {
      // Stream chunks; the server may 413 + close mid-upload, so ignore write errors.
      (async () => {
        for (const c of body.chunks) {
          if (req.destroyed) return;
          if (!req.write(c)) {
            await new Promise((r) => {
              const done = () => { req.off("drain", done); req.off("close", done); r(); };
              req.on("drain", done); req.on("close", done);
            });
          }
        }
        req.end();
      })().catch(() => {});
    } else {
      req.end(body);
    }
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const mcpHeaders = { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Parse a JSON-RPC reply that may be plain JSON or an SSE stream. */
function rpcResult(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5));
  }
  throw new Error(`unparseable reply: ${trimmed.slice(0, 200)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) { if (pred()) return true; await sleep(50); }
  return pred();
}

/**
 * Tiny Streamable-HTTP MCP client. Request replies come back on the POST
 * (JSON or SSE); server-initiated notifications unrelated to a request
 * (resources/updated) only go to the standalone GET SSE stream, so `listen()`
 * opens that stream and collects them.
 */
class McpHttpClient {
  constructor(extraHeaders = {}) { this.extra = extraHeaders; this.nextId = 1; this.notifs = []; }
  headers() {
    return { ...mcpHeaders, ...this.extra, ...(this.sid ? { "mcp-session-id": this.sid, "mcp-protocol-version": "2025-03-26" } : {}) };
  }
  async init(name) {
    const r = await request(`${BASE}/mcp`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version: "0" } } }),
    });
    this.sid = r.headers["mcp-session-id"];
    if (r.status !== 200 || !this.sid) throw new Error(`initialize → ${r.status} ${r.text.slice(0, 200)}`);
    await request(`${BASE}/mcp`, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    return this;
  }
  async rpc(method, params = {}) {
    const id = this.nextId++;
    const r = await request(`${BASE}/mcp`, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (r.status !== 200) throw new Error(`${method} → HTTP ${r.status} ${r.text.slice(0, 200)}`);
    const msgs = r.text.trim().startsWith("{") ? [JSON.parse(r.text)]
      : r.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    const reply = msgs.find((m) => m.id === id);
    if (!reply) throw new Error(`${method}: no reply in ${r.text.slice(0, 200)}`);
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }
  listen() {
    const u = new URL(`${BASE}/mcp`);
    const mod = u.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      this.sse = mod.request(u, { method: "GET", headers: { ...this.headers(), accept: "text/event-stream" }, rejectUnauthorized: false }, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`GET SSE → ${res.statusCode}`)); res.resume(); return; }
        let buf = "";
        res.on("data", (c) => {
          buf += c.toString("utf8");
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            try { this.notifs.push({ ...JSON.parse(line.slice(5)), at: Date.now() }); } catch { /* partial */ }
          }
        });
        res.on("error", () => {});
        resolve();
      });
      this.sse.on("error", () => {});
      this.sse.end();
    });
  }
  updates(uri, since = 0) {
    return this.notifs.filter((n) => n.method === "notifications/resources/updated" && n.params?.uri === uri && n.at >= since);
  }
  async close() {
    const r = await request(`${BASE}/mcp`, { method: "DELETE", headers: this.headers() });
    this.sse?.destroy();
    return r.status;
  }
}

function daemonLogCount(needle) {
  const out = execFileSync(
    "docker",
    ["exec", CONTAINER, "sh", "-c", 'cat "${LEAN_CHRONOSCOPE_LOG_DIR:-/var/log/lean-chronoscope}"/*.log'],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split("\n").filter((l) => l.includes(`"msg":"${needle}"`)).length;
}

console.log(`# http-bridge smoke (${BASE}, tls=${TLS}, rate=${RATE}/min, sessionRate=${SESSION_RATE}/min)`);

const health = await request(`${BASE}/health`);
ok(health.status === 200 && JSON.parse(health.text).ok === true, `/health → ${health.status}`);

const bad = await request(`${BASE}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: "Bearer nope" }, body: "{}" });
ok(bad.status === 401, `bad token → ${bad.status}`);
const badLen = await request(`${BASE}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${TOKEN}x` }, body: "{}" });
ok(badLen.status === 401, `token with wrong length → ${badLen.status}`);
const none = await request(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
ok(none.status === 401, `no Authorization → ${none.status}`);

const initialize = () => request(`${BASE}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke-http", version: "0" } },
  }),
});
const init = await initialize();
const sid = init.headers["mcp-session-id"];
const initRes = init.status === 200 ? rpcResult(init.text) : null;
ok(init.status === 200 && !!sid && initRes?.result?.serverInfo?.name === "lean-chronoscope-mcp",
  `initialize → ${init.status}, sid=${sid ? "yes" : "no"}`);

if (sid) {
  const sess = { ...mcpHeaders, "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" };
  await request(`${BASE}/mcp`, { method: "POST", headers: sess, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const list = await request(`${BASE}/mcp`, { method: "POST", headers: sess, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  const tools = list.status === 200 ? rpcResult(list.text)?.result?.tools ?? [] : [];
  ok(tools.length > 0, `tools/list → ${list.status}, ${tools.length} tools`);

  const big = Buffer.alloc(MAX_BODY + 1024, 0x20);
  const tooBig = await request(`${BASE}/mcp`, { method: "POST", headers: sess, body: big })
    .catch((err) => ({ status: `error ${err.code ?? err.message}` }));
  ok(tooBig.status === 413, `body ${big.length}B (Content-Length) → ${tooBig.status}`);

  const chunk = Buffer.alloc(256 * 1024, 0x20);
  const chunks = Array.from({ length: Math.ceil((MAX_BODY + 1024) / chunk.length) }, () => chunk);
  const tooBigChunked = await request(`${BASE}/mcp`, {
    method: "POST", headers: { ...sess, "transfer-encoding": "chunked" }, body: { chunks },
  }).catch((err) => ({ status: `error ${err.code ?? err.message}` }));
  ok(tooBigChunked.status === 413, `body ${chunks.length * chunk.length}B (chunked) → ${tooBigChunked.status}`);

  // Session still usable after the rejected uploads.
  const list2 = await request(`${BASE}/mcp`, { method: "POST", headers: sess, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
  ok(list2.status === 200, `tools/list after 413 → ${list2.status}`);

  const del = await request(`${BASE}/mcp`, { method: "DELETE", headers: sess });
  ok(del.status === 200 || del.status === 204, `DELETE session → ${del.status}`);
}

if (MAX_SESSIONS > 0) {
  // Fill the cap, expect 503 on the next initialize, then free the slots.
  const opened = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const r = await initialize();
    if (r.headers["mcp-session-id"]) opened.push(r.headers["mcp-session-id"]);
  }
  const over = await initialize();
  ok(opened.length === MAX_SESSIONS && over.status === 503,
    `${opened.length}/${MAX_SESSIONS} sessions open, next initialize → ${over.status}`);
  for (const s of opened) {
    await request(`${BASE}/mcp`, { method: "DELETE", headers: { ...mcpHeaders, "mcp-session-id": s, "mcp-protocol-version": "2025-03-26" } });
  }
  const again = await initialize();
  ok(again.status === 200, `initialize after freeing slots → ${again.status}`);
  if (again.headers["mcp-session-id"]) {
    await request(`${BASE}/mcp`, { method: "DELETE", headers: { ...mcpHeaders, "mcp-session-id": again.headers["mcp-session-id"], "mcp-protocol-version": "2025-03-26" } });
  }
}

{
  // Two clients pinned to one daemon session share one screencast URI. Each HTTP
  // MCP session has its own daemon connection, so A's unsubscribe must not end
  // B's stream, and B's disconnect must release the CDP screencast.
  console.log("# shared screencast subscription");
  const shared = `smoke-http-cast-${Date.now()}`;
  const ANIM_URL = "data:text/html," + encodeURIComponent(
    `<style>@keyframes s{from{transform:translateX(0)}to{transform:translateX(300px)}}
     #b{width:80px;height:80px;background:#c33;animation:s 1s linear infinite alternate}</style><div id="b"></div>`);
  const a = await new McpHttpClient({ "x-lc-session": shared }).init("smoke-cast-a");
  const b = await new McpHttpClient({ "x-lc-session": shared }).init("smoke-cast-b");
  try {
    await a.listen();
    await b.listen();
    const nav = await a.rpc("tools/call", { name: "page_navigate", arguments: { url: ANIM_URL } });
    ok(!nav.isError, "page_navigate (animated data: URL) via tools/call");
    const listed = await b.rpc("resources/list");
    const castUri = listed.resources.map((r) => r.uri).find((u) => /^browser:\/\/session\/[^/]+\/page\/[^/]+\/screencast$/.test(u));
    ok(!!castUri && castUri.includes(`/session/${shared}/`), `screencast URI listed: ${castUri}`);
    const startedBefore = CONTAINER ? daemonLogCount("screencast started") : 0;
    const t0 = Date.now();
    await a.rpc("resources/subscribe", { uri: castUri });
    await b.rpc("resources/subscribe", { uri: castUri });
    await waitFor(() => a.updates(castUri, t0).length >= 1 && b.updates(castUri, t0).length >= 1, 5000);
    ok(a.updates(castUri, t0).length >= 1 && b.updates(castUri, t0).length >= 1,
      `both subscribed → A ${a.updates(castUri, t0).length}, B ${b.updates(castUri, t0).length} updates`);
    if (CONTAINER) ok(daemonLogCount("screencast started") === startedBefore + 1, "one CDP screencast for both subscribers");

    await a.rpc("resources/unsubscribe", { uri: castUri });
    await sleep(700); // drain in-flight emits
    const t1 = Date.now();
    await sleep(2500);
    ok(b.updates(castUri, t1).length >= 1, `A unsubscribed → B still gets updates (${b.updates(castUri, t1).length} in 2.5s)`);
    ok(a.updates(castUri, t1).length === 0, `A gets none after unsubscribe (${a.updates(castUri, t1).length})`);

    const stoppedBefore = CONTAINER ? daemonLogCount("screencast stopped") : 0;
    const delB = await b.close(); // no unsubscribe first
    ok(delB === 200 || delB === 204, `B DELETE without unsubscribe → ${delB}`);
    if (CONTAINER) {
      await waitFor(() => daemonLogCount("screencast stopped") > stoppedBefore, 5000);
      ok(daemonLogCount("screencast stopped") > stoppedBefore, "daemon logged 'screencast stopped' after B disconnected");
    } else {
      console.log("  - (set LC_CONTAINER to check the daemon log for 'screencast stopped')");
    }
    const still = await a.rpc("tools/list");
    ok(still.tools?.length > 0, "A still usable after B left (shared daemon session kept)");
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
}

if (SESSION_RATE > 0) {
  // Authenticated requests are bucketed per MCP session: exhausting A's bucket
  // must not affect B, even though both come from the same IP.
  console.log("# per-session rate limit");
  const a = await new McpHttpClient().init("smoke-rate-a");
  const b = await new McpHttpClient().init("smoke-rate-b");
  try {
    // Overshoot generously: the bucket refills at rate/60 per second while the burst runs.
    const n = Math.ceil(SESSION_RATE * 1.5) + 10;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    const results = await Promise.all(Array.from({ length: n }, () =>
      request(`${BASE}/mcp`, { method: "POST", headers: a.headers(), body })));
    const limited = results.filter((r) => r.status === 429).length;
    ok(limited > 0, `session A burst of ${n} → ${limited}×429, ${results.filter((r) => r.status === 200).length}×200`);
    const bList = await b.rpc("tools/list").then((r) => r.tools.length, (e) => e.message);
    ok(typeof bList === "number", `session B unaffected → tools/list ${bList} tools`);
  } finally {
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
}

if (TLS) {
  const plain = BASE.replace(/^https:/, "http:");
  const r = await request(`${plain}/health`).then((x) => `status ${x.status}`, (err) => `error ${err.code ?? err.message}`);
  ok(!r.startsWith("status 200"), `plain http:// on TLS port fails (${r})`);
}

if (RATE > 0) {
  // Burst with a bad token: failed auth attempts are throttled per IP. A live
  // session (opened before the flood) must keep working through it.
  console.log("# failed-auth rate limit");
  const liveClient = await new McpHttpClient().init("smoke-live");
  const n = RATE + 10;
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      request(`${BASE}/mcp`, { method: "POST", headers: { ...mcpHeaders, authorization: "Bearer nope" }, body: "{}" }),
    ),
  );
  const limited = results.filter((r) => r.status === 429);
  ok(limited.length > 0 && Number(limited[0].headers["retry-after"]) >= 1,
    `burst of ${n} → ${limited.length}×429 (Retry-After ${limited[0]?.headers["retry-after"]}), ${results.filter((r) => r.status === 401).length}×401`);
  const h = await request(`${BASE}/health`);
  ok(h.status === 200, `/health not rate limited → ${h.status}`);
  const during = await liveClient.rpc("tools/list").then((r) => r.tools.length, (e) => e.message);
  ok(typeof during === "number", `live session during bad-token lockout → tools/list ${during} tools`);
  const fresh = await initialize();
  ok(fresh.status === 429, `new initialize from the locked-out IP → ${fresh.status} (until the bucket refills)`);
  ok((await liveClient.close()) === 200, "live session DELETE");
}

console.log(process.exitCode ? "FAIL" : "PASS");
