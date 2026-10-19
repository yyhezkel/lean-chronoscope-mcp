#!/usr/bin/env node
// v1.7 smoke: the `browser://session/{sid}/page/{pid}/screencast` resource.
// Drives the MCP server over stdio and checks: the URI is listed (image/jpeg),
// subscribe → ≥2 resources/updated within 5s on an animated page, read returns
// a base64 JPEG blob, unsubscribe → no more updates and the daemon logs
// "screencast stopped", and page_close while subscribed is clean.
// (g) with SMOKE_PAGE_IDLE_MS set (container run with matching
// LEAN_CHRONOSCOPE_PAGE_IDLE_MS + a short REAPER_INTERVAL_MS): a non-selected
// page watched only via screencast survives the page reaper, then is reaped
// after unsubscribe. (h) subscribing before the page exists starts the cast
// once the page is created.
//
//   LC_CONTAINER=lc-test-f LC_TEST_PORT=18806 scripts/test-container.sh
//   LC_CONTAINER=lc-test-f node scripts/smoke-test-v17-screencast.mjs

import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";

const CONTAINER = process.env.LC_CONTAINER ?? "lean-chronoscope-mcp";
const PAGE_IDLE_MS = Number(process.env.SMOKE_PAGE_IDLE_MS ?? 0);
const REAPER_MS = Number(process.env.SMOKE_REAPER_INTERVAL_MS ?? 2000);
const SESSION_ID = process.env.SMOKE_SESSION ?? `v17-cast-${Date.now()}`;
const ANIM_URL =
  "data:text/html," +
  encodeURIComponent(
    `<style>@keyframes s{from{transform:translateX(0)}to{transform:translateX(300px)}}
     #b{width:80px;height:80px;background:#c33;animation:s 1s linear infinite alternate}</style>
     <div id="b"></div>`,
  );

function ok(cond, label) {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}
// The daemon logs (pino JSON) to $LEAN_CHRONOSCOPE_LOG_DIR, not docker stdout.
function daemonLogCount(needle) {
  const out = execFileSync(
    "docker",
    ["exec", CONTAINER, "sh", "-c", 'cat "${LEAN_CHRONOSCOPE_LOG_DIR:-/var/log/lean-chronoscope}"/*.log'],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
  return out.split("\n").filter((l) => l.includes(`"msg":"${needle}"`)).length;
}

async function main() {
  console.log(`# v1.7 screencast smoke (container=${CONTAINER}, session=${SESSION_ID})`);
  const proc = spawn(
    "docker",
    ["exec", "-i", CONTAINER, "node", "/app/dist/bin/mcp.js", "--session", SESSION_ID],
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
      notifs.push({ ...msg, at: Date.now() });
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params = {}) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const tool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const updatesFor = (uri, since = 0) =>
    notifs.filter((n) => n.method === "notifications/resources/updated" && n.params?.uri === uri && n.at >= since);

  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-v17-screencast", version: "0.0.0" },
    });
    notify("notifications/initialized");

    console.log("\n[1] navigate to an animated page");
    await tool("page_navigate", { url: ANIM_URL });
    const pagesUri = `browser://session/${SESSION_ID}/pages`;
    const pages = JSON.parse((await rpc("resources/read", { uri: pagesUri })).contents[0].text).data;
    const pageId = pages.find((p) => p.selected)?.pageId;
    ok(!!pageId, `selected page=${pageId}`);
    const castUri = `browser://session/${SESSION_ID}/page/${pageId}/screencast`;

    console.log("\n[2] resources/list includes the screencast URI");
    const list = await rpc("resources/list", {});
    const entry = list.resources.find((r) => r.uri === castUri);
    ok(!!entry, castUri);
    ok(entry?.mimeType === "image/jpeg", `mimeType=${entry?.mimeType}`);

    console.log("\n[3] read before subscribe → on-demand capture");
    const cold = await rpc("resources/read", { uri: castUri });
    ok(cold.contents?.[0]?.mimeType === "image/jpeg", "image/jpeg");
    ok(cold.contents?.[0]?.blob?.startsWith("/9j/"), "JPEG magic (/9j/)");

    console.log("\n[4] subscribe → ≥2 updates within 5s");
    const stoppedBefore = daemonLogCount("screencast stopped");
    const startedBefore = daemonLogCount("screencast started");
    const t0 = Date.now();
    await rpc("resources/subscribe", { uri: castUri });
    await waitFor(() => updatesFor(castUri, t0).length >= 2, 5000);
    const n = updatesFor(castUri, t0).length;
    ok(n >= 2, `updates received: ${n} in ${Date.now() - t0}ms`);
    ok(daemonLogCount("screencast started") > startedBefore, "daemon logged 'screencast started'");

    console.log("\n[5] read while subscribed → live frame");
    const live = await rpc("resources/read", { uri: castUri });
    const c0 = live.contents?.[0];
    ok(c0?.mimeType === "image/jpeg", `mimeType=${c0?.mimeType}`);
    ok(typeof c0?.blob === "string" && c0.blob.startsWith("/9j/"), `blob is base64 JPEG (${c0?.blob?.length ?? 0} b64 chars)`);
    ok(c0?.text === undefined, "no text field on blob content");

    console.log("\n[6] rate stays ~2fps");
    const t1 = Date.now();
    await sleep(3000);
    const rate = updatesFor(castUri, t1).length / 3;
    ok(rate > 0.5 && rate <= 3, `~${rate.toFixed(2)} updates/s over 3s`);

    console.log("\n[7] unsubscribe → no more updates; screencast stopped");
    await rpc("resources/unsubscribe", { uri: castUri });
    await sleep(700); // drain any debounce/in-flight emit
    const t2 = Date.now();
    await sleep(3000);
    ok(updatesFor(castUri, t2).length === 0, `updates after unsubscribe: ${updatesFor(castUri, t2).length}`);
    ok(daemonLogCount("screencast stopped") > stoppedBefore, "daemon logged 'screencast stopped'");

    console.log("\n[8] page_close while subscribed");
    await tool("page_new", { url: ANIM_URL });
    const pages2 = JSON.parse((await rpc("resources/read", { uri: pagesUri })).contents[0].text).data;
    const pid2 = pages2.find((p) => p.selected)?.pageId;
    const castUri2 = `browser://session/${SESSION_ID}/page/${pid2}/screencast`;
    const t3 = Date.now();
    const stopped2 = daemonLogCount("screencast stopped");
    await rpc("resources/subscribe", { uri: castUri2 });
    await waitFor(() => updatesFor(castUri2, t3).length >= 1, 5000);
    ok(updatesFor(castUri2, t3).length >= 1, `page ${pid2} streaming`);
    const closed = await tool("page_close", { pageId: pid2 });
    ok(!closed.isError, "page_close ok while subscribed");
    await sleep(1000);
    ok(daemonLogCount("screencast stopped") > stopped2, "screencast stopped on page close");
    let readErr = null;
    try { await rpc("resources/read", { uri: castUri2 }); } catch (e) { readErr = e; }
    ok(readErr != null, `read on closed page errors cleanly (${readErr?.message?.slice(0, 60)})`);
    await rpc("resources/unsubscribe", { uri: castUri2 });
    ok(true, "unsubscribe after page close returned");

    const readPages = async () =>
      JSON.parse((await rpc("resources/read", { uri: pagesUri })).contents[0].text).data;
    let lastPid = null;

    if (PAGE_IDLE_MS > 0) {
      console.log(`\n[g] watched non-selected page survives the reaper (PAGE_IDLE_MS=${PAGE_IDLE_MS})`);
      await tool("page_new", { url: ANIM_URL }); // selected
      const before = new Set((await readPages()).map((p) => p.pageId));
      await tool("page_new", { url: ANIM_URL, background: true });
      const pagesG = await readPages();
      const pidW = pagesG.find((p) => !before.has(p.pageId))?.pageId;
      ok(!!pidW && !pagesG.find((p) => p.pageId === pidW)?.selected, `watched page ${pidW} is not selected`);
      lastPid = pidW;
      const castUriW = `browser://session/${SESSION_ID}/page/${pidW}/screencast`;
      await rpc("resources/subscribe", { uri: castUriW });
      await sleep(PAGE_IDLE_MS + 2 * REAPER_MS + 1500);
      ok((await readPages()).some((p) => p.pageId === pidW), `${pidW} not reaped after ${PAGE_IDLE_MS + 2 * REAPER_MS + 1500}ms`);
      const t4 = Date.now();
      await sleep(2000);
      ok(updatesFor(castUriW, t4).length >= 1, `updates still flowing: ${updatesFor(castUriW, t4).length} in 2s`);
      await rpc("resources/unsubscribe", { uri: castUriW });
      await waitFor(() => false, 2 * REAPER_MS + 1000);
      ok(!(await readPages()).some((p) => p.pageId === pidW), `${pidW} reaped after unsubscribe`);
    } else {
      console.log("\n[g] skipped (set SMOKE_PAGE_IDLE_MS + run the container with a short PAGE_IDLE_MS)");
    }

    console.log("\n[h] subscribe before the page exists → cast starts on page creation");
    if (!lastPid) {
      await tool("page_new", { url: ANIM_URL });
      lastPid = (await readPages()).find((p) => p.selected)?.pageId;
    }
    const predicted = `p_${Number(lastPid.slice(2)) + 1}`;
    const castUriH = `browser://session/${SESSION_ID}/page/${predicted}/screencast`;
    await rpc("resources/subscribe", { uri: castUriH });
    const t5 = Date.now();
    await tool("page_new", { url: ANIM_URL });
    const pidH = (await readPages()).find((p) => p.selected)?.pageId;
    ok(pidH === predicted, `new page id ${pidH} (predicted ${predicted})`);
    await waitFor(() => updatesFor(castUriH, t5).length >= 2, 5000);
    ok(updatesFor(castUriH, t5).length >= 2, `updates after late page creation: ${updatesFor(castUriH, t5).length}`);
    await rpc("resources/unsubscribe", { uri: castUriH });

    const status = await tool("daemon_status");
    ok(!status.isError, "daemon still healthy");
  } finally {
    await tool("session_close").catch(() => {});
    proc.stdin.end();
    // `docker exec -i` doesn't propagate EOF; kill the child.
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("close", r));
  }
  console.log(process.exitCode ? "\n# FAIL" : "\n# PASS");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
