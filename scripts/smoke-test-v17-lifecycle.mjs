// v1.7.0 lifecycle smoke: per-session serialization (D1) + page-level reaper (D2).
// Needs a container started with short reaper knobs, e.g.:
//   LC_CONTAINER=lc-test-d LC_TEST_PORT=18804 scripts/test-container.sh \
//     -e LEAN_CHRONOSCOPE_PAGE_IDLE_MS=6000 -e LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS=2000 \
//     -e LEAN_CHRONOSCOPE_MAX_PAGES_PER_SESSION=3
//   LC_CONTAINER=lc-test-d node scripts/smoke-test-v17-lifecycle.mjs
import { spawnMcp, sleep } from "./tools/harness.mjs";

const PAGE_IDLE_MS = Number(process.env.PAGE_IDLE_MS ?? 6000);
const TICK_MS = Number(process.env.REAPER_INTERVAL_MS ?? 2000);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 3);

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
      ok(before === 5 && after <= MAX_PAGES, `(b) page cap trims 5 → ≤${MAX_PAGES}`, `before=${before} after=${after}`);
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

  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
