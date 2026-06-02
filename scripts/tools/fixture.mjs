// Seed-page fixture. Chromium denies IndexedDB / real storage on `data:` URLs
// (opaque origin), so we serve a rich HTML page from a fake HTTPS host via an
// interception `respond` rule. The host never resolves DNS — the rule short-
// circuits every request. Two rules: the document and a JSON API endpoint the
// page fetches (gives the network log a completed request with a body).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const SEED_URL = "https://tool-smoke.test/";
export const API_URL = "https://tool-smoke.test/api/data";
export const SEED_HTML = readFileSync(join(here, "../fixtures/tool-smoke.html"), "utf8");

export async function installSeed({ callTool, sc }) {
  const doc = sc(
    await callTool("intercept_add", {
      urlPattern: SEED_URL,
      action: { kind: "respond", status: 200, mimeType: "text/html", body: SEED_HTML },
    }),
  );
  const api = sc(
    await callTool("intercept_add", {
      urlPattern: "https://tool-smoke.test/api/*",
      action: {
        kind: "respond",
        status: 200,
        mimeType: "application/json",
        body: JSON.stringify({ net_marker: "toolsmoke_net_zzz" }),
      },
    }),
  );
  return { docRuleId: doc.rule?.id, apiRuleId: api.rule?.id };
}
