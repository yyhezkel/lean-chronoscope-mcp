#!/usr/bin/env node
// HTTP-bridge hardening smoke, over real HTTP(S) against a running bridge:
//   /health 200 · bad token 401 · initialize + tools/list · body > cap → 413
//   (declared Content-Length and chunked) · burst over the rate limit → 429.
// TLS mode (URL starts with https://): same checks with rejectUnauthorized:false,
// plus "plain http:// to the same port fails".
//
// Env: LC_HTTP_URL (default http://127.0.0.1:18803), LC_HTTP_TOKEN (default
// test-token), LC_MAX_BODY (default 4 MiB, must match the bridge),
// LC_RATE_PER_MIN (bridge's HTTP_RATE_PER_MIN; burst check skipped when 0),
// LC_MAX_SESSIONS (bridge's HTTP_MAX_SESSIONS; when set, fills the cap and
// expects 503 on the next initialize).
import http from "node:http";
import https from "node:https";

const BASE = (process.env.LC_HTTP_URL ?? "http://127.0.0.1:18803").replace(/\/$/, "");
const TOKEN = process.env.LC_HTTP_TOKEN ?? "test-token";
const MAX_BODY = Number(process.env.LC_MAX_BODY ?? 4 * 1024 * 1024);
const RATE = Number(process.env.LC_RATE_PER_MIN ?? 60);
const MAX_SESSIONS = Number(process.env.LC_MAX_SESSIONS ?? 0);
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

console.log(`# http-bridge smoke (${BASE}, tls=${TLS}, rate=${RATE}/min)`);

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

if (TLS) {
  const plain = BASE.replace(/^https:/, "http:");
  const r = await request(`${plain}/health`).then((x) => `status ${x.status}`, (err) => `error ${err.code ?? err.message}`);
  ok(!r.startsWith("status 200"), `plain http:// on TLS port fails (${r})`);
}

if (RATE > 0) {
  // Burst with a bad token: also proves failed auth attempts are throttled.
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
}

console.log(process.exitCode ? "FAIL" : "PASS");
