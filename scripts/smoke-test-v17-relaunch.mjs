// v1.7.0 in-process Chrome relaunch smoke (task E): kill Chrome under a live
// session and assert the daemon survives, relaunches Chrome, rebinds the
// session (same MCP connection keeps working), keeps captured history and
// intercept rules.
//   LC_CONTAINER=lc-test-e LC_TEST_PORT=18805 scripts/test-container.sh
//   LC_CONTAINER=lc-test-e node scripts/smoke-test-v17-relaunch.mjs
import { execFileSync } from "node:child_process";
import { spawnMcp, sleep, CONTAINER } from "./tools/harness.mjs";

let failed = 0;
const ok = (cond, label, extra = "") => {
  console.log(`  [${cond ? "x" : " "}] ${label} … ${cond ? "PASS" : "FAIL"}${extra ? `  (${extra})` : ""}`);
  if (!cond) failed++;
};
const dx = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const daemonPid = () => dx("exec", CONTAINER, "pgrep", "-f", "dist/bin/daemon.js").split("\n")[0];
const chromePids = () => {
  try {
    return dx("exec", CONTAINER, "pgrep", "-f", "chrome").split("\n").filter(Boolean);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
};
const containerStarted = () => dx("inspect", "-f", "{{.State.StartedAt}} {{.RestartCount}}", CONTAINER);

async function main() {
  console.log(`# v1.7.0 Chrome relaunch smoke (${CONTAINER})\n`);
  const m = spawnMcp(`v17-relaunch-${Date.now()}`);
  await m.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "v17-relaunch", version: "0.0.0" },
  });
  m.notify("notifications/initialized");
  const call = async (name, args = {}) => {
    const r = await m.callTool(name, args);
    if (r.isError) throw new Error(`${name}: ${m.txt(r)}`);
    return r;
  };

  try {
    // --- before: history + an intercept rule serving a fake HTTPS origin.
    await call("intercept_add", {
      urlPattern: "https://relaunch.test/*",
      action: {
        kind: "respond",
        status: 200,
        mimeType: "text/html",
        body: "<html><body><h1 id=t>INTERCEPTED</h1><script>console.log('marker-before-kill')</script></body></html>",
      },
    });
    const nav1 = m.sc(await call("page_navigate", { url: "https://relaunch.test/one" }));
    const oldPageId = nav1.pageId;
    await sleep(500);
    const c1 = m.sc(await call("console_list", { pageId: oldPageId }));
    ok((c1.rows ?? []).some((r) => r.text.includes("marker-before-kill")), "console captured before kill");
    const n1 = m.sc(await call("network_list", { pageId: oldPageId }));
    ok((n1.rows ?? []).some((r) => r.url.includes("relaunch.test")), "network captured before kill");

    const pid0 = daemonPid();
    const started0 = containerStarted();
    const chrome0 = chromePids();
    ok(chrome0.length > 0, "chrome processes found", `n=${chrome0.length}`);

    // --- kill Chrome (every chrome process) out from under the daemon.
    try {
      dx("exec", CONTAINER, "pkill", "-9", "-f", "chrome");
    } catch {
      /* pkill exit codes are noisy */
    }

    // Wait for the relaunch (first attempt after ~1s + launch time).
    let st;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        st = m.sc(await call("daemon_status"));
        if (st.chromeRelaunches >= 1 && st.browserConnected) break;
      } catch {
        /* daemon briefly busy */
      }
    }
    ok(daemonPid() === pid0, "daemon PID unchanged", `pid=${pid0}`);
    ok(containerStarted() === started0, "container not restarted", started0);
    ok(st?.ok === true && st?.browserConnected === true, "daemon_status ok + browser connected");
    ok(st?.chromeRelaunches === 1, "chromeRelaunches = 1", `got ${st?.chromeRelaunches}`);
    ok(typeof st?.lastChromeRelaunchAt === "number", "lastChromeRelaunchAt set");
    const chrome1 = chromePids();
    ok(chrome1.length > 0 && !chrome1.some((p) => chrome0.includes(p)), "fresh chrome processes", `n=${chrome1.length}`);

    // --- after: same MCP session keeps working.
    const rules = m.sc(await call("intercept_list")).rules ?? [];
    ok(rules.some((r) => r.urlPattern === "https://relaunch.test/*"), "intercept rule survived", `rules=${rules.length}`);
    const nav2 = m.sc(await call("page_navigate", { url: "https://relaunch.test/two" }));
    ok(!!nav2.pageId && nav2.pageId !== oldPageId, "page_navigate works in same session (new page)", nav2.pageId);
    const ev = m.txt(await call("script_evaluate", { expression: "document.getElementById('t')?.textContent" }));
    ok(ev.includes("INTERCEPTED"), "intercept rule still applied on new page");

    const c2 = m.sc(await call("console_list", { pageId: oldPageId, includePreserved: true }));
    ok((c2.rows ?? []).some((r) => r.text.includes("marker-before-kill")), "pre-kill console history readable");
    const n2 = m.sc(await call("network_list", { pageId: oldPageId, includePreserved: true }));
    ok((n2.rows ?? []).some((r) => r.url.includes("relaunch.test/one")), "pre-kill network history readable");
    const pl = m.sc(await call("page_list")).pages ?? [];
    ok(pl.length === 1 && pl[0].pageId === nav2.pageId, "page_list shows only the new page", `n=${pl.length}`);

    await call("session_close").catch(() => {});
  } finally {
    await m.close();
  }
  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
