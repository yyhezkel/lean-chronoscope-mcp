#!/usr/bin/env node
// Test 1: stdout cleanliness.
// Every line on mcp-server's stdout MUST be a valid JSON-RPC 2.0 message.
// Anything else (log lines, puppeteer warnings, stack traces) breaks MCP framing.

import { spawn } from "node:child_process";
import readline from "node:readline";

const proc = spawn(
  "docker",
  ["exec", "-i", "browser-mcp", "node", "/app/dist/bin/mcp.js", "--session", "stdout-test"],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const stdoutLines = [];
const stderrLines = [];
const rl = readline.createInterface({ input: proc.stdout });
const erl = readline.createInterface({ input: proc.stderr });
rl.on("line", (l) => stdoutLines.push(l));
erl.on("line", (l) => stderrLines.push(l));

const pending = new Map();
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// Hook into stdout to also resolve pending RPCs.
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    /* invalid JSON — caught later */
  }
});

async function main() {
  // 1. Initialize.
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });

  // 2. Valid call.
  await rpc("tools/list", {});

  // 3. Unknown tool.
  await rpc("tools/call", { name: "nonexistent_tool", arguments: {} });

  // 4. Invalid arguments (missing url).
  await rpc("tools/call", { name: "page_navigate", arguments: {} });

  // 5. Tool that throws (navigate to invalid scheme).
  await rpc("tools/call", { name: "page_navigate", arguments: { url: "https://this-domain-definitely-does-not-exist-12345.invalid" } });

  // 6. Malformed JSON line directly to stdin (mcp-server should ignore or fail gracefully).
  proc.stdin.write("not json at all\n");

  // 7. JSON-RPC malformed (no method).
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 999 }) + "\n");

  // Give it a moment for any straggler output.
  await new Promise((r) => setTimeout(r, 1500));

  proc.stdin.end();
  proc.kill();

  // Analyze.
  console.log(`stdout: ${stdoutLines.length} lines`);
  console.log(`stderr: ${stderrLines.length} lines`);

  let invalidLines = 0;
  let invalidExamples = [];
  for (const line of stdoutLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.jsonrpc !== "2.0") {
        invalidLines++;
        if (invalidExamples.length < 3) invalidExamples.push(line);
      }
    } catch {
      invalidLines++;
      if (invalidExamples.length < 3) invalidExamples.push(line);
    }
  }

  if (invalidLines > 0) {
    console.error("\n❌ STDOUT NOT CLEAN");
    console.error(`${invalidLines} invalid line(s) on stdout. Examples:`);
    invalidExamples.forEach((l) => console.error("  | " + l.slice(0, 200)));
    process.exit(1);
  }

  console.log("\nstdout sample (first 3 lines):");
  stdoutLines.slice(0, 3).forEach((l) => console.log("  " + l.slice(0, 120) + (l.length > 120 ? "..." : "")));

  if (stderrLines.length > 0) {
    console.log("\nstderr (informational — must not contain MCP frames):");
    stderrLines.slice(0, 5).forEach((l) => console.log("  | " + l.slice(0, 200)));
    const stderrLooksLikeMcp = stderrLines.some((l) => {
      try { return JSON.parse(l).jsonrpc === "2.0"; } catch { return false; }
    });
    if (stderrLooksLikeMcp) {
      console.error("\n❌ MCP frame leaked to stderr");
      process.exit(1);
    }
  }

  console.log("\n✅ stdout is clean: all lines are valid JSON-RPC 2.0 messages");
  process.exit(0);
}

main().catch((err) => { console.error("test failed:", err); proc.kill(); process.exit(1); });
