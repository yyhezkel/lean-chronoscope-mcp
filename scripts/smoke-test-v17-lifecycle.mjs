// v1.7.0 lifecycle smoke: per-session serialization (D1) + page-level reaper (D2).
// Needs a container started with short reaper knobs, e.g.:
//   LC_CONTAINER=lc-test-d LC_TEST_PORT=18804 scripts/test-container.sh \
//     -e LEAN_CHRONOSCOPE_PAGE_IDLE_MS=6000 -e LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS=2000 \
//     -e LEAN_CHRONOSCOPE_MAX_PAGES_PER_SESSION=3 -e LEAN_CHRONOSCOPE_LOCKED_OP_TIMEOUT_MS=8000
//   LC_CONTAINER=lc-test-d OP_TIMEOUT_MS=8000 node scripts/smoke-test-v17-lifecycle.mjs
// (e) concurrent creates of a brand-new session id (raw daemon socket, since the
// stdio MCP ensures its session at startup); (f) locked-op timeout + unlocked
// page_close. OP_TIMEOUT_MS must match the container's LOCKED_OP_TIMEOUT_MS
// (default 60000 — works, just slow).
import { execFileSync } from "node:child_process";
import { spawnMcp, sleep, CONTAINER } from "./tools/harness.mjs";

const PAGE_IDLE_MS = Number(process.env.PAGE_IDLE_MS ?? 6000);
const TICK_MS = Number(process.env.REAPER_INTERVAL_MS ?? 2000);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);
const OP_TIMEOUT_MS = Number(process.env.OP_TIMEOUT_MS ?? 60000);

// Fire all `calls` ([method, params]) at the daemon socket at once, without
// awaiting between them; returns the JSON-RPC responses in call order.
function daemonBurst(calls) {
  const prog = `
    const net = require("node:net"), rl = require("node:readline");
    const calls = JSON.parse(process.argv[1]); const out = new Array(calls.length); let left = calls.length;
    const s = net.createConnection("/run/lean-chronoscope/daemon.sock", () => {
      calls.forEach(([method, params], i) => s.write(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params }) + "\\n"));
    });
    rl.createInterface({ input: s }).on("line", (l) => {
      const m = JSON.parse(l); if (m.id == null) return;
      out[m.id - 1] = m; if (--left === 0) { console.log(JSON.stringify(out)); s.end(); process.exit(0); }
    });
    setTimeout(() => { console.log(JSON.stringify(out)); process.exit(0); }, 60000);`;
  const stdout = execFileSync("docker", ["exec", CONTAINER, "node", "-e", prog, JSON.stringify(calls)], {
    encoding: "utf8",
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

const html = (body) => "data:text/html," + encodeURIComponent(`<html><body>${body}</body></html>`);
let failed = 0;
const ok = (cond, label, extra = "") => {
  console.log(`  [${cond ? "x" : " "}] ${label} … ${cond ? "PASS" : "FAIL"}${extra ? `  (${extra})` : ""}`);
  if (!cond) failed++;
};

async function open(sessionId) {
  const mcp = spawnMcp(sessionId);
  await mcp.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "v17-lifecycle", version: "0.0.0" },
  });
  mcp.notify("notifications/initialized");
  // Tool errors come back as isError results; turn them into rejections.
  const call = async (name, args = {}) => {
    const r = await mcp.callTool(name, args);
    if (r.isError) throw new Error(`${name}: ${mcp.txt(r)}`);
    return r;
  };
  const pages = async () => mcp.sc(await call("page_list")).pages ?? [];
  return { ...mcp, call, pages };
}

async function main() {
  const stamp = Date.now();
  console.log("# v1.7.0 lifecycle smoke\n");

  // (a) un-awaited navigate + snapshot on a fresh, page-less session.
  {
    const m = await open(`v17-a-${stamp}`);
    try {
      const nav = m.call("page_navigate", { url: html("<h1>race-target</h1>") });
      const snap = m.call("snapshot_take");
      const [n, s] = await Promise.allSettled([nav, snap]);
      ok(n.status === "fulfilled", "(a) navigate succeeds", n.reason?.message);
      ok(s.status === "fulfilled" && m.txt(s.value).includes("race-target"),
        "(a) concurrent snapshot succeeds after navigate", s.reason?.message);
      const p = await m.pages();
      ok(p.length === 1, "(a) exactly one page", `pages=${p.length}`);
      await m.call("session_close").catch(() => {});
    } finally {
      await m.close();
    }
  }

  // (b) page cap: open 5 pages → reaper trims to MAX_PAGES within a few ticks.
  {
    const m = await open(`v17-b-${stamp}`);
    try {
      for (let i = 0; i < 5; i++) await m.call("page_new", { url: html(`page ${i}`) });
      const before = (await m.pages()).length;
      let after = before;
      const deadline = Date.now() + TICK_MS * 4;
      while (Date.now() < deadline && after > MAX_PAGES) {
        await sleep(500);
        after = (await m.pages()).length;
      }
      // 5 pages were opened; a reaper tick may already trim mid-loop, so only `after` is asserted.
      ok(after <= MAX_PAGES, `(b) page cap trims 5 → ≤${MAX_PAGES}`, `before=${before} after=${after}`);
      await m.call("session_close").catch(() => {});
    } finally {
      await m.close();
    }
  }

  // (c) idle non-selected page closed; the actively used selected page survives.
  {
    const m = await open(`v17-c-${stamp}`);
    try {
      const keep = m.sc(await m.call("page_new", { url: html("keep") })).pageId;
      const idle = m.sc(await m.call("page_new", { url: html("idle"), background: true })).pageId;
      await m.call("page_select", { pageId: keep });
      const end = Date.now() + PAGE_IDLE_MS + TICK_MS * 3;
      while (Date.now() < end) {
        await m.call("script_evaluate", { expression: "1+1" }); // keep `keep` busy
        await sleep(700);
      }
      const ids = (await m.pages()).map((p) => p.pageId);
      ok(!ids.includes(idle), "(c) idle non-selected page reaped", `pages=${ids.join(",")}`);
      ok(ids.includes(keep), "(c) selected page survives");
      await m.call("session_close").catch(() => {});
    } finally {
      await m.close();
    }
  }

  // (d) a long wait_for does NOT block a concurrent navigate on the same session.
  {
    const m = await open(`v17-d-${stamp}`);
    try {
      await m.call("page_navigate", { url: html("start") });
      const t0 = Date.now();
      let waitDone = 0;
      const wait = m.call("wait_for", { text: "never-appears-xyz", timeoutMs: 10_000 }).then((r) => {
        waitDone = Date.now() - t0;
        return r;
      });
      await sleep(300);
      await m.call("page_navigate", { url: html("next") });
      const navDone = Date.now() - t0;
      const w = m.sc(await wait);
      ok(navDone < 5000 && waitDone >= 9000, "(d) navigate not blocked by wait_for",
        `nav=${navDone}ms wait=${waitDone}ms matched=${w.matched}`);
      await m.call("session_close").catch(() => {});
    } finally {
      await m.close();
    }
  }

  // (e) brand-new session id: 3 concurrent navigates → one Session, one page,
  // one "session created" log line (ensure dedupes in-flight creations).
  {
    const sid = `v17-e-${stamp}`;
    const navs = [1, 2, 3].map((i) => ["page.navigate", { sessionId: sid, url: html(`burst ${i}`) }]);
    const res = daemonBurst([...navs]);
    ok(res.length === 3 && res.every((r) => r && r.result && !r.error), "(e) 3 concurrent navigates succeed",
      res.map((r) => r?.error?.message ?? "ok").join(" | "));
    const [list] = daemonBurst([["page.list", { sessionId: sid }]]);
    const n = list?.result?.pages?.length;
    ok(n === 1, "(e) exactly one page", `pages=${n}`);
    // The daemon logs to $LEAN_CHRONOSCOPE_LOG_DIR inside the container, not stdout.
    const logs = execFileSync("docker", ["exec", CONTAINER, "sh", "-c",
      'cat "${LEAN_CHRONOSCOPE_LOG_DIR:-/var/log/lean-chronoscope}"/*.log'], { encoding: "utf8" });
    const created = logs.split("\n").filter((l) => l.includes("session created") && l.includes(sid)).length;
    ok(created === 1, '(e) "session created" logged exactly once', `count=${created}`);
    daemonBurst([["session.close", { sessionId: sid }]]);
  }

  // (f) a never-settling evaluate is abandoned at the op timeout (lock freed);
  // page_close is unlocked so it closes a page whose evaluate hangs.
  {
    const m = await open(`v17-f-${stamp}`);
    try {
      await m.call("page_navigate", { url: html("eval-host") });
      const t0 = Date.now();
      const r = await m.callTool("script_evaluate", { expression: "new Promise(() => {})", awaitPromise: true })
        .catch((e) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      const dt = Date.now() - t0;
      ok(r.isError && /within|timeout|timed out/i.test(m.txt(r)) && dt < OP_TIMEOUT_MS + 5000,
        "(f) hung evaluate returns timeout error within bound", `${dt}ms: ${m.txt(r).slice(0, 120)}`);
      const n = await m.call("page_navigate", { url: html("after-timeout") }).then(() => true, (e) => e.message);
      ok(n === true, "(f) navigate works after evaluate timeout", n === true ? "" : n);

      const t1 = Date.now();
      const hung = m.callTool("script_evaluate", { expression: "new Promise(() => {})", awaitPromise: true })
        .then((x) => ({ at: Date.now() - t1, x }), (e) => ({ at: Date.now() - t1, e }));
      await sleep(500);
      const c = await m.call("page_close").then(() => true, (e) => e.message);
      const closeMs = Date.now() - t1;
      ok(c === true && closeMs < 5000, "(f) page_close succeeds while evaluate hangs", `${closeMs}ms ${c === true ? "" : c}`);
      const h = await hung;
      ok(h.at < 5000, "(f) hung evaluate released by page_close", `${h.at}ms`);
      await m.call("session_close").catch(() => {});
    } finally {
      await m.close();
    }
  }

  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
