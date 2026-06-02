#!/usr/bin/env node
// M3 smoke: cookies + localStorage + IndexedDB + interception + emulation + redaction.
//
// Runs against the docker daemon over stdio MCP (via `docker exec -i`).

import { spawn } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `m3-${Date.now()}`;

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}

async function main() {
  console.log(`# M3 smoke (session=${SESSION_ID})`);

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
  function callTool(name, args) {
    return rpc("tools/call", { name, arguments: args });
  }
  function bodyOf(callResult) {
    const item = callResult.content.find((c) => c.type === "text");
    return item ? item.text : "";
  }
  function structuredOf(callResult) {
    return callResult.structuredContent ?? {};
  }

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-m3", version: "0.0.0" },
  });
  notify("notifications/initialized");

  // Need a page to act against (localStorage, IDB, etc. live in browser context).
  await callTool("page_navigate", { url: "about:blank" });

  // ---- M3.1 cookies ----
  console.log("\n[M3.1] cookies");
  // about:blank has no cookie store. Use a real-ish URL via data: doesn't work either.
  // Navigate to example.com so cookies have a real domain.
  await callTool("page_navigate", { url: "https://example.com/" });
  await callTool("cookies_set", {
    cookies: [
      { name: "smoke", value: "yes", url: "https://example.com/", path: "/" },
      { name: "trace", value: "abc", domain: "example.com", path: "/" },
    ],
  });
  const cList = structuredOf(await callTool("cookies_list", {}));
  ok(cList.count >= 2, `cookies_list count >= 2 (got ${cList.count})`);
  ok(
    cList.cookies?.some((c) => c.name === "smoke" && c.value === "yes"),
    "smoke=yes round-trip",
  );
  const cleared = structuredOf(await callTool("cookies_clear", { name: "smoke" }));
  ok(cleared.cleared >= 1, `cookies_clear by name removed ${cleared.cleared}`);

  // ---- M3.2 storage ----
  console.log("\n[M3.2] localStorage");
  await callTool("localStorage_set", { key: "k1", value: "v1" });
  await callTool("localStorage_set", { key: "k2", value: "v2" });
  const lsGet = structuredOf(await callTool("localStorage_get", { key: "k1" }));
  ok(lsGet.value === "v1", `localStorage_get k1 = ${lsGet.value}`);
  const lsList = structuredOf(await callTool("localStorage_list", {}));
  ok(lsList.totalKeys === 2, `localStorage_list totalKeys=${lsList.totalKeys}`);
  await callTool("localStorage_clear", {});
  const lsList2 = structuredOf(await callTool("localStorage_list", {}));
  ok(lsList2.totalKeys === 0, "localStorage_clear emptied storage");

  // ---- M3.3 IndexedDB ----
  console.log("\n[M3.3] IndexedDB");
  // Chromium blocks IndexedDB on `data:` URLs (opaque origin), so serve the
  // seed HTML from a stable HTTPS origin via interception. The fake host
  // never resolves DNS; the intercept short-circuits the request.
  const seedHtml = `<!doctype html><html><head><title>idb-seeding</title></head><body><script>
    const open = indexedDB.open("smokeDb", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("things", { keyPath: "id" });
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("things", "readwrite");
      tx.objectStore("things").put({ id: 1, name: "alpha" });
      tx.objectStore("things").put({ id: 2, name: "beta" });
      tx.oncomplete = () => { db.close(); document.title = "idb-ready"; };
    };
  </script></body></html>`;
  const seedRule = structuredOf(
    await callTool("intercept_add", {
      urlPattern: "https://idb-smoke.test/",
      action: { kind: "respond", status: 200, mimeType: "text/html", body: seedHtml },
    }),
  );
  await callTool("page_navigate", { url: "https://idb-smoke.test/" });
  await new Promise((r) => setTimeout(r, 600));
  const idbDbs = structuredOf(await callTool("indexeddb_list_databases", {}));
  ok(
    (idbDbs.databases ?? []).some((d) => d.name === "smokeDb"),
    `IDB list includes smokeDb (got ${(idbDbs.databases ?? []).map((d) => d.name).join(",")})`,
  );
  const idbQ = structuredOf(
    await callTool("indexeddb_query", { database: "smokeDb", store: "things" }),
  );
  ok(idbQ.count === 2, `IDB query count=${idbQ.count}`);
  ok(idbQ.rows?.length === 2, "IDB query returned 2 rows");
  await callTool("intercept_remove", { id: seedRule.rule.id });

  // ---- M3.4 interception ----
  console.log("\n[M3.4] interception");
  const ruleResp = structuredOf(
    await callTool("intercept_add", {
      urlPattern: "https://api.example.test/*",
      action: { kind: "respond", status: 418, body: '{"hello":"mock"}', mimeType: "application/json" },
      oneShot: false,
    }),
  );
  ok(ruleResp.rule?.id?.startsWith("r_"), `rule id=${ruleResp.rule?.id}`);
  const listed = structuredOf(await callTool("intercept_list", {}));
  ok(listed.count === 1, `intercept_list count=${listed.count}`);
  // Trigger a fetch from the page to the mocked URL.
  await callTool("page_navigate", {
    url:
      "data:text/html," +
      encodeURIComponent(`<script>
        fetch("https://api.example.test/foo")
          .then(r => r.json().then(j => { document.title = r.status + ":" + j.hello; }));
      </script>`),
  });
  await new Promise((r) => setTimeout(r, 500));
  const listed2 = structuredOf(await callTool("intercept_list", {}));
  ok(listed2.rules?.[0]?.hits === 1, `rule hit count=${listed2.rules?.[0]?.hits}`);
  const removed = structuredOf(await callTool("intercept_remove", { id: ruleResp.rule.id }));
  ok(removed.removed === true, "intercept_remove returned removed=true");

  // ---- M3.5 emulation ----
  console.log("\n[M3.5] emulation");
  const vp = structuredOf(
    await callTool("emulate_viewport", { width: 375, height: 812, isMobile: true, hasTouch: true }),
  );
  ok(vp.width === 375 && vp.height === 812, `viewport ${vp.width}x${vp.height}`);
  const ua = structuredOf(
    await callTool("emulate_useragent", { userAgent: "SmokeBot/1.0" }),
  );
  ok(ua.userAgent === "SmokeBot/1.0", "UA override returned");
  const net = structuredOf(await callTool("emulate_network", { preset: "Slow 3G" }));
  ok(net.applied?.latencyMs === 400, `network latencyMs=${net.applied?.latencyMs}`);
  // Reset network so subsequent navigations aren't artificially slow.
  await callTool("emulate_network", { preset: "online" });
  const geo = structuredOf(
    await callTool("emulate_geolocation", { latitude: 32.0853, longitude: 34.7818 }),
  );
  ok(geo.cleared === false, "geolocation override applied");

  // ---- M3.6 redaction ----
  console.log("\n[M3.6] redaction");
  // Trigger a fetch carrying an Authorization header to a non-trusted host
  // (example.com is external), so network_get sees and should redact it.
  await callTool("page_navigate", {
    url:
      "data:text/html," +
      encodeURIComponent(`<script>
        fetch("https://example.com/", { headers: { Authorization: "Bearer SECRET_TOKEN_xyz_123456" } })
          .then(() => document.title = "done").catch(() => document.title = "err");
      </script>`),
  });
  await new Promise((r) => setTimeout(r, 1200));
  const netList = structuredOf(await callTool("network_list", {}));
  // There may be several example.com rows (the GET carrying Authorization + a
  // CORS preflight). Scan all of them; assert one shows the redacted header and
  // none leak the raw token.
  const exampleRows = (netList.rows ?? []).filter((r) => r.url?.includes("example.com"));
  ok(exampleRows.length > 0, `network_list captured example.com request(s) (n=${exampleRows.length})`);
  {
    const texts = [];
    for (const row of exampleRows) {
      const detail = await callTool("network_get", { reqid: row.id, part: "meta" });
      texts.push(bodyOf(detail));
    }
    const joined = texts.join("\n");
    const text = joined; // for the raw-token check below
    ok(
      joined.includes("authorization: [REDACTED]") || joined.includes("Authorization: [REDACTED]"),
      "Authorization header redacted",
    );
    ok(!text.includes("SECRET_TOKEN_xyz_123456"), "raw token absent from output");
  }

  proc.stdin.end();
  proc.kill("SIGTERM");
  await new Promise((r) => proc.on("close", r));
  console.log("\n# done");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
