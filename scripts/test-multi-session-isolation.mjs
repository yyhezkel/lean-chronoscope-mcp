#!/usr/bin/env node
// Test 2: multi-session isolation.
// Two browser sessions (via createBrowserContext) must not share cookies or localStorage.
// Talks directly to the daemon socket (bypassing MCP).

import { spawn } from "node:child_process";

// We run the test from inside the container so we can connect to the unix socket.
const script = `
import net from "node:net";

const SOCKET = "/run/browser-mcp/daemon.sock";
let nextId = 1;
const sock = net.createConnection(SOCKET);
let buf = "";
const pending = new Map();
sock.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }
});
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  });
}

async function main() {
  await new Promise((r) => sock.once("connect", r));
  const results = {};

  // Session A
  await rpc("session.ensure", { sessionId: "iso-A" });
  await rpc("page.navigate", { sessionId: "iso-A", url: "https://example.com" });
  await rpc("page.evaluate", {
    sessionId: "iso-A",
    expression: 'document.cookie = "isolationTest=fromA; path=/"; localStorage.setItem("isolationTest","fromA"); return "set";'
  });
  const aCookies = await rpc("page.evaluate", { sessionId: "iso-A", expression: "document.cookie" });
  const aLs = await rpc("page.evaluate", { sessionId: "iso-A", expression: 'localStorage.getItem("isolationTest")' });
  results.aCookies = aCookies.value;
  results.aLs = aLs.value;

  // Session B (must be isolated)
  await rpc("session.ensure", { sessionId: "iso-B" });
  await rpc("page.navigate", { sessionId: "iso-B", url: "https://example.com" });
  const bCookies = await rpc("page.evaluate", { sessionId: "iso-B", expression: "document.cookie" });
  const bLs = await rpc("page.evaluate", { sessionId: "iso-B", expression: 'localStorage.getItem("isolationTest")' });
  results.bCookies = bCookies.value;
  results.bLs = bLs.value;

  process.stdout.write(JSON.stringify(results));
  sock.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
`;

const proc = spawn(
  "docker",
  ["exec", "-i", "browser-mcp", "node", "--input-type=module", "-e", script],
  { stdio: ["pipe", "pipe", "inherit"] },
);

let stdout = "";
proc.stdout.on("data", (d) => (stdout += d.toString()));

proc.on("close", (code) => {
  if (code !== 0) {
    console.error(`❌ in-container script exited ${code}`);
    process.exit(1);
  }
  const r = JSON.parse(stdout);
  console.log("Session A: cookie=", r.aCookies, " localStorage=", r.aLs);
  console.log("Session B: cookie=", r.bCookies, " localStorage=", r.bLs);

  const bSeesCookie = typeof r.bCookies === "string" && r.bCookies.includes("isolationTest");
  const bSeesLs = r.bLs != null;
  const aHasIt = typeof r.aCookies === "string" && r.aCookies.includes("isolationTest=fromA");

  if (!aHasIt) {
    console.error("\n❌ Session A didn't even retain its own cookie (test setup broken)");
    process.exit(1);
  }
  if (bSeesCookie || bSeesLs) {
    console.error("\n❌ ISOLATION FAILED");
    if (bSeesCookie) console.error("  Session B sees cookie from A:", r.bCookies);
    if (bSeesLs) console.error("  Session B sees localStorage from A:", r.bLs);
    process.exit(1);
  }
  console.log("\n✅ Session A set cookie & localStorage; Session B sees neither → isolation works");
});
