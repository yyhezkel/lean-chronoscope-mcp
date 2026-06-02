// Shared boilerplate for the per-tool test suite: spawn the stdio MCP server
// inside the running container, speak JSON-RPC over its stdio, and tear it down
// cleanly (docker exec -i does NOT propagate stdin EOF, so SIGTERM is required).
import { spawn } from "node:child_process";
import readline from "node:readline";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function spawnMcp(sessionId) {
  const proc = spawn(
    "docker",
    ["exec", "-i", "browser-mcp", "node", "/app/dist/bin/mcp.js", "--session", sessionId],
    { stdio: ["pipe", "pipe", "inherit"] },
  );

  const rl = readline.createInterface({ input: proc.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
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
  const callTool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const sc = (r) => r.structuredContent ?? {};
  const txt = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
  const hasImage = (r) => !!r.content?.some((c) => c.type === "image");

  async function close() {
    try { proc.stdin.end(); } catch {}
    proc.kill("SIGTERM");
    await new Promise((res) => proc.on("close", res));
  }

  return { proc, rpc, notify, callTool, sc, txt, hasImage, close };
}

// Find the [uid] of an interactive element in a snapshot tree by its (unique)
// accessible name. Snapshot lines look like: `[e12] textbox "smoke-text"`.
export function uidByLabel(snapText, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = snapText.match(new RegExp("\\[(e\\d+)\\][^\\n]*" + escaped));
  return m ? m[1] : null;
}
