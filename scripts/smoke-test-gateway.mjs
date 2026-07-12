#!/usr/bin/env node
// Gateway-mode smoke: LEAN_CHRONOSCOPE_GATEWAY=1 advertises 3 meta-tools instead of
// 56 (mount cost ~321 tok vs ~5,258). Verify catalog → schema → invoke works
// end-to-end, and that the underlying 56 are reachable via tools_invoke.
import { spawn } from "node:child_process";
import readline from "node:readline";

const SESSION_ID = process.env.SMOKE_SESSION ?? `gw-${Date.now()}`;
const ok = (c, l) => { if (c) console.log(`  ✓ ${l}`); else { console.log(`  ✗ ${l}`); process.exitCode = 1; } };

const proc = spawn(
  "docker",
  ["exec", "-i", "-e", "LEAN_CHRONOSCOPE_GATEWAY=1", "lean-chronoscope-mcp",
   "node", "/app/dist/bin/mcp.js", "--session", SESSION_ID],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();
let nid = 1;
rl.on("line", (l) => {
  if (!l.trim()) return;
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(`${m.error.code}: ${m.error.message}`));
    else resolve(m.result);
  }
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nid++; pending.set(id, { resolve, reject });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params = {}) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const callTool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const sc = (r) => r.structuredContent ?? {};
const txt = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

console.log(`# gateway smoke (session=${SESSION_ID})`);
await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "gw-smoke", version: "0" },
});
notify("notifications/initialized");

const tl = await rpc("tools/list", {});
ok(tl.tools.length === 3, `tools/list advertises 3 (got ${tl.tools.length})`);
const advertised = new Set(tl.tools.map((t) => t.name));
for (const n of ["tools_catalog", "tool_schema", "tools_invoke"]) {
  ok(advertised.has(n), `${n} advertised`);
}

const cat = sc(await callTool("tools_catalog", {}));
ok(cat.total === 56, `tools_catalog total=${cat.total}`);
ok(typeof cat.categories?.input === "object", "categories.input present");

const oneCat = sc(await callTool("tools_catalog", { category: "storage" }));
ok((oneCat.total ?? 0) >= 10, `category filter storage total=${oneCat.total}`);

const sch = sc(await callTool("tool_schema", { names: ["cookies_set", "page_navigate", "nope_tool"] }));
ok(sch.schemas?.cookies_set?.inputSchema?.type === "object", "cookies_set schema present");
ok(sch.schemas?.page_navigate?.inputSchema?.required?.includes("url"), "page_navigate schema lists url required");
ok((sch.missing ?? []).includes("nope_tool"), "unknown tool reported in missing");

// Real dispatch: navigate + snapshot via tools_invoke. example.com is cheap.
const nav = sc(await callTool("tools_invoke", { tool: "page_navigate", args: { url: "https://example.com/" } }));
ok(nav.status === 200, `tools_invoke→page_navigate status=${nav.status}`);

const snap = sc(await callTool("tools_invoke", { tool: "snapshot_take", args: {} }));
ok(typeof snap.snapshotId === "number" && snap.uidCount > 0, `tools_invoke→snapshot_take uidCount=${snap.uidCount}`);

// The 56 stay callable by name even when gateway is advertised (additive, not restrictive).
const direct = sc(await callTool("daemon_status", {}));
ok(/^\d+\.\d+\.\d+$/.test(direct.version ?? ""), `direct daemon_status still works (v${direct.version})`);

// tools_invoke must refuse a gateway tool (no recursion).
const bad = await callTool("tools_invoke", { tool: "tools_catalog", args: {} });
ok(bad.isError === true, "tools_invoke refuses gateway tools");

await callTool("tools_invoke", { tool: "session_close", args: {} });
proc.stdin.end();
proc.kill("SIGTERM");
await new Promise((r) => proc.on("close", r));
console.log("\n# done");
