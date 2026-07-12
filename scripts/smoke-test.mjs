#!/usr/bin/env node
// M0 smoke test: spawns mcp-server in container via docker exec -i,
// drives initialize -> tools/list -> page_navigate -> screenshot_take.

import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";

const sessionId = process.env.SMOKE_SESSION ?? "smoke";
const targetUrl = process.env.SMOKE_URL ?? "https://example.com";

const proc = spawn(
  "docker",
  [
    "exec",
    "-i",
    "lean-chronoscope-mcp",
    "node",
    "/app/dist/bin/mcp.js",
    "--session",
    sessionId,
    "--daemon-socket",
    "/run/lean-chronoscope/daemon.sock",
  ],
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

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function main() {
  console.log("[1/4] initialize");
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" },
  });
  console.log("    server:", init.serverInfo);

  console.log("[2/4] tools/list");
  const tools = await rpc("tools/list", {});
  console.log("    tools:", tools.tools.map((t) => t.name).join(", "));

  console.log(`[3/4] tools/call page_navigate -> ${targetUrl}`);
  const navRes = await rpc("tools/call", {
    name: "page_navigate",
    arguments: { url: targetUrl },
  });
  const navText = navRes.content.find((c) => c.type === "text")?.text ?? "";
  console.log("    " + navText.split("\n").slice(0, 4).join(" | "));

  console.log("[4/4] tools/call screenshot_take");
  const shotRes = await rpc("tools/call", {
    name: "screenshot_take",
    arguments: {},
  });
  const shotText = shotRes.content.find((c) => c.type === "text")?.text ?? "";
  const shotImg = shotRes.content.find((c) => c.type === "image");
  console.log("    " + shotText.split("\n").slice(0, 3).join(" | "));
  if (!shotImg) throw new Error("No image in screenshot response");
  console.log(`    image: ${shotImg.mimeType}, base64 length=${shotImg.data.length}`);

  const outPath = "/tmp/smoke-screenshot.png";
  fs.writeFileSync(outPath, Buffer.from(shotImg.data, "base64"));
  console.log(`    saved to ${outPath} (${fs.statSync(outPath).size} bytes)`);

  console.log("\n✅ M0 smoke test passed");
  proc.stdin.end();
  proc.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ smoke test failed:", err.message);
  proc.kill();
  process.exit(1);
});
