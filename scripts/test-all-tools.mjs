#!/usr/bin/env node
// Control runner for the per-tool test suite. Drives all 56 MCP tools over ONE
// shared stdio session in dependency order, prints a checkbox/PASS-FAIL matrix,
// and closes its session at the end (so repeated runs don't pile up contexts).
//
// Simple tools are tested inline below; tools that need real setup live in
// their own files under scripts/tools/ and are imported here.
//
//   docker cp scripts/fixtures/upload.txt lean-chronoscope-mcp:/tmp/tool-upload.txt   # (done automatically)
//   node scripts/test-all-tools.mjs
//
// Exits 0 only when every tool PASSes.
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnMcp, sleep } from "./tools/harness.mjs";
import * as fixture from "./tools/fixture.mjs";
import { run as inputTests } from "./tools/input.mjs";
import { run as networkTests } from "./tools/network.mjs";
import { run as idbTests } from "./tools/indexeddb.mjs";
import { run as interceptTests } from "./tools/intercept.mjs";
import { run as snapshotTests } from "./tools/snapshot.mjs";
import { run as lifecycleTests } from "./tools/lifecycle.mjs";

const SESSION_ID = process.env.SMOKE_SESSION ?? `alltools-${Date.now()}`;
const CONTAINER_UPLOAD = "/tmp/tool-upload.txt";

// Master ordered tool list, grouped by category (56 total).
const CATEGORIES = {
  Session: ["session_list", "session_new", "session_close", "session_attach"],
  Pages: ["page_navigate", "page_list", "page_new", "page_select", "page_close", "page_back", "page_forward", "page_reload"],
  "Snapshot/Screenshot": ["snapshot_take", "snapshot_diff", "screenshot_take", "wait_for"],
  Console: ["console_list", "console_get", "console_search"],
  Network: ["network_list", "network_get", "network_search", "network_wait_for"],
  Input: ["click", "hover", "type", "fill_form", "key", "scroll", "drag", "upload_file"],
  "Storage: Cookies": ["cookies_list", "cookies_set", "cookies_clear"],
  "Storage: localStorage": ["localStorage_get", "localStorage_set", "localStorage_remove", "localStorage_clear", "localStorage_list"],
  "Storage: sessionStorage": ["sessionStorage_get", "sessionStorage_set", "sessionStorage_remove", "sessionStorage_clear", "sessionStorage_list"],
  "Storage: IndexedDB": ["indexeddb_list_databases", "indexeddb_query", "indexeddb_clear"],
  Intercept: ["intercept_add", "intercept_list", "intercept_remove"],
  Emulation: ["emulate_viewport", "emulate_useragent", "emulate_network", "emulate_geolocation"],
  Performance: ["performance_metrics", "daemon_status"],
  Script: ["script_evaluate"],
};
const ALL = Object.values(CATEGORIES).flat();
const results = new Map(ALL.map((n) => [n, { status: "SKIP", note: "" }]));

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

async function main() {
  console.log(`# all-tools test (session=${SESSION_ID}) — ${ALL.length} tools\n`);

  // Place the upload fixture inside the container for upload_file.
  try {
    const local = fileURLToPath(new URL("./fixtures/upload.txt", import.meta.url));
    execSync(`docker cp "${local}" lean-chronoscope-mcp:${CONTAINER_UPLOAD}`, { stdio: "ignore" });
  } catch (e) {
    console.error("warn: could not copy upload fixture:", e.message);
  }

  const mcp = spawnMcp(SESSION_ID);
  const { callTool, sc, txt, hasImage, close } = mcp;

  await mcp.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "all-tools", version: "0.0.0" },
  });
  mcp.notify("notifications/initialized");

  const state = { uploadPath: CONTAINER_UPLOAD, seedUrl: fixture.SEED_URL };

  async function t(tool, fn) {
    try {
      const note = await fn();
      results.set(tool, { status: "PASS", note: note ?? "" });
      console.log(`  [x] ${tool} … PASS${note ? `  (${note})` : ""}`);
    } catch (e) {
      results.set(tool, { status: "FAIL", note: e.message });
      process.exitCode = 1;
      console.log(`  [ ] ${tool} … FAIL  ${e.message}`);
    }
  }

  const ctx = { callTool, sc, txt, hasImage, t, assert, sleep, state };

  // ---- diagnostics ----
  await t("daemon_status", async () => {
    const r = sc(await callTool("daemon_status", {}));
    assert(/^\d+\.\d+\.\d+$/.test(r.version), `version=${r.version}`);
    assert(r.browserConnected === true, "browser not connected");
    return `v${r.version}`;
  });
  await t("session_list", async () => {
    const r = sc(await callTool("session_list", {}));
    assert((r.sessions ?? []).some((s) => s.id === SESSION_ID), "our session not listed");
    return `${r.sessions.length} sessions`;
  });

  await t("session_attach", async () => {
    const title = `attach-smoke-${SESSION_ID}`;
    const a = sc(await callTool("session_attach", { title }));
    assert(a.created === true && a.attached === true, "attach-or-create failed");
    const reuse = sc(await callTool("session_attach", { title }));
    assert(reuse.created === false && reuse.sessionId === a.sessionId, "by-title reuse failed");
    // Switch back so the rest of the suite runs on our original session.
    const back = sc(await callTool("session_attach", { sessionId: SESSION_ID }));
    assert(back.sessionId === SESSION_ID, "switch back to original session failed");
    // Clean up the throwaway attached session.
    await callTool("session_close", { sessionId: a.sessionId });
    return `created+reused ${a.sessionId.slice(0, 12)}, back to original`;
  });

  // ---- intercept (self-contained throwaway rule) ----
  await interceptTests(ctx);

  // ---- install seed page + navigate ----
  const seedRules = await fixture.installSeed(ctx);
  await t("page_navigate", async () => {
    const r = sc(await callTool("page_navigate", { url: fixture.SEED_URL }));
    assert(r.status === 200, `status=${r.status}`);
    return `status ${r.status}`;
  });
  await t("wait_for", async () => {
    const r = sc(await callTool("wait_for", { text: "READY_TOKEN", timeoutMs: 8000 }));
    assert(r.matched === true, `timed out after ${r.waitedMs}ms`);
    return `${r.waitedMs}ms`;
  });
  await t("snapshot_take", async () => {
    const r0 = await callTool("snapshot_take", {});
    state.snapText = txt(r0);
    const r = sc(r0);
    assert(typeof r.snapshotId === "number", "no snapshotId");
    assert(r.uidCount > 0, `uidCount=${r.uidCount}`);
    return `${r.uidCount} uids`;
  });

  // ---- input tools (need the seed page + a snapshot) ----
  await inputTests(ctx);

  // ---- script_evaluate ----
  await t("script_evaluate", async () => {
    const r = sc(await callTool("script_evaluate", { expression: "6 * 7" }));
    assert(r.value === 42, `value=${r.value}`);
    return "42";
  });

  // ---- console (seed page logged 3 messages on load) ----
  let msgid;
  await t("console_list", async () => {
    const r = sc(await callTool("console_list", { pageSize: 50, group: false }));
    assert((r.rows?.length ?? 0) >= 3, `rows=${r.rows?.length}`);
    msgid = r.rows[0].id;
    return `${r.rows.length} msgs`;
  });
  await t("console_get", async () => {
    assert(msgid, "no msgid from console_list");
    const r = sc(await callTool("console_get", { msgid }));
    assert(typeof r.text === "string", "no text");
    return `#${r.id}`;
  });
  await t("console_search", async () => {
    const r = sc(await callTool("console_search", { query: "toolsmoke_log_marker" }));
    assert((r.total ?? 0) >= 1, `total=${r.total}`);
    return `total=${r.total}`;
  });

  // ---- network (seed page fetched /api/data) ----
  await networkTests(ctx);

  // ---- cookies ----
  await t("cookies_set", async () => {
    const r = sc(await callTool("cookies_set", {
      cookies: [
        { name: "smoke", value: "yes", domain: "tool-smoke.test", path: "/" },
        { name: "trace", value: "abc", domain: "tool-smoke.test", path: "/" },
      ],
    }));
    assert(r.set >= 2, `set=${r.set}`);
    return `set ${r.set}`;
  });
  await t("cookies_list", async () => {
    const r = sc(await callTool("cookies_list", {}));
    assert((r.cookies ?? []).some((c) => c.name === "smoke" && c.value === "yes"), "smoke cookie missing");
    return `count=${r.count}`;
  });
  await t("cookies_clear", async () => {
    const r = sc(await callTool("cookies_clear", { name: "smoke" }));
    assert(r.cleared >= 1, `cleared=${r.cleared}`);
    return `cleared ${r.cleared}`;
  });

  // ---- localStorage ----
  await t("localStorage_set", async () => {
    const r = sc(await callTool("localStorage_set", { key: "k1", value: "v1" }));
    assert(r.key === "k1", "key mismatch");
    return "k1";
  });
  await t("localStorage_get", async () => {
    const r = sc(await callTool("localStorage_get", { key: "k1" }));
    assert(r.value === "v1", `value=${r.value}`);
    return r.value;
  });
  await t("localStorage_list", async () => {
    await callTool("localStorage_set", { key: "k2", value: "v2" });
    const r = sc(await callTool("localStorage_list", {}));
    assert(r.totalKeys >= 2, `totalKeys=${r.totalKeys}`);
    return `${r.totalKeys} keys`;
  });
  await t("localStorage_remove", async () => {
    const r = sc(await callTool("localStorage_remove", { key: "k1" }));
    assert(r.existed === true, "key did not exist");
    return "removed";
  });
  await t("localStorage_clear", async () => {
    await callTool("localStorage_clear", {});
    const r = sc(await callTool("localStorage_list", {}));
    assert(r.totalKeys === 0, `totalKeys=${r.totalKeys}`);
    return "emptied";
  });

  // ---- sessionStorage ----
  await t("sessionStorage_set", async () => {
    const r = sc(await callTool("sessionStorage_set", { key: "s1", value: "w1" }));
    assert(r.key === "s1", "key mismatch");
    return "s1";
  });
  await t("sessionStorage_get", async () => {
    const r = sc(await callTool("sessionStorage_get", { key: "s1" }));
    assert(r.value === "w1", `value=${r.value}`);
    return r.value;
  });
  await t("sessionStorage_list", async () => {
    const r = sc(await callTool("sessionStorage_list", {}));
    assert(r.totalKeys >= 1, `totalKeys=${r.totalKeys}`);
    return `${r.totalKeys} keys`;
  });
  await t("sessionStorage_remove", async () => {
    const r = sc(await callTool("sessionStorage_remove", { key: "s1" }));
    assert(r.existed === true, "key did not exist");
    return "removed";
  });
  await t("sessionStorage_clear", async () => {
    await callTool("sessionStorage_clear", {});
    const r = sc(await callTool("sessionStorage_list", {}));
    assert(r.totalKeys === 0, `totalKeys=${r.totalKeys}`);
    return "emptied";
  });

  // ---- IndexedDB (active page is still the seed page) ----
  await idbTests(ctx);

  // ---- snapshot_diff ----
  await snapshotTests(ctx);

  // ---- emulation ----
  await t("emulate_viewport", async () => {
    const r = sc(await callTool("emulate_viewport", { width: 1024, height: 768 }));
    assert(r.width === 1024 && r.height === 768, `${r.width}x${r.height}`);
    return `${r.width}x${r.height}`;
  });
  await t("emulate_useragent", async () => {
    const r = sc(await callTool("emulate_useragent", { userAgent: "ToolSmokeBot/1.0" }));
    assert(r.userAgent === "ToolSmokeBot/1.0", "UA not echoed");
    return "ua set";
  });
  await t("emulate_geolocation", async () => {
    const r = sc(await callTool("emulate_geolocation", { latitude: 32.0853, longitude: 34.7818 }));
    assert(r.cleared === false, "override not applied");
    return "geo set";
  });
  await t("emulate_network", async () => {
    const r = sc(await callTool("emulate_network", { preset: "Slow 3G" }));
    assert(r.applied, "no applied conditions");
    await callTool("emulate_network", { preset: "online" }); // restore
    return "throttled+restored";
  });

  // ---- performance ----
  await t("performance_metrics", async () => {
    const r = sc(await callTool("performance_metrics", {}));
    assert(r.metrics && typeof r.metrics.Nodes === "number", `Nodes=${r.metrics?.Nodes}`);
    return `Nodes=${r.metrics.Nodes}`;
  });

  // ---- screenshot ----
  await t("screenshot_take", async () => {
    const r0 = await callTool("screenshot_take", { format: "jpeg" });
    assert(hasImage(r0), "no image content");
    const r = sc(r0);
    assert(r.width > 0 && r.height > 0, `${r.width}x${r.height}`);
    return `${r.width}x${r.height}`;
  });

  // ---- page + session lifecycle (churns pages — run last) ----
  await lifecycleTests(ctx);

  // ---- teardown: remove seed rules, close our own session (positive close) ----
  try { if (seedRules.docRuleId) await callTool("intercept_remove", { id: seedRules.docRuleId }); } catch {}
  try { if (seedRules.apiRuleId) await callTool("intercept_remove", { id: seedRules.apiRuleId }); } catch {}
  await t("session_close", async () => {
    const r = sc(await callTool("session_close", {}));
    assert(r.closed === true, `closed=${r.closed}`);
    return `closed ${r.sessionId}`;
  });

  await close();
  printMatrix();
}

function pad(s, n) {
  return s + " " + ".".repeat(Math.max(2, n - s.length));
}

function printMatrix() {
  console.log("\n# Results\n");
  let pass = 0, fail = 0, skip = 0;
  for (const [cat, tools] of Object.entries(CATEGORIES)) {
    console.log(`## ${cat}`);
    for (const tool of tools) {
      const r = results.get(tool);
      if (r.status === "PASS") pass++;
      else if (r.status === "FAIL") fail++;
      else skip++;
      const box = r.status === "PASS" ? "[x]" : "[ ]";
      console.log(`  ${box} ${pad(tool, 26)} ${r.status}${r.note ? `  ${r.note}` : ""}`);
    }
  }
  const parts = [`${pass}/${ALL.length} PASS`];
  if (fail) parts.push(`${fail} FAIL`);
  if (skip) parts.push(`${skip} SKIP`);
  console.log(`\nSummary: ${parts.join(", ")}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
