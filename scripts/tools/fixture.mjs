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
/** Secret carried in a query param by the seed page's second fetch; must never surface in tool output. */
export const URL_SECRET = "SECRET123";
/** Secret in the seed page's own URL (page_navigate target); must never surface in tool output. */
export const PAGE_SECRET = "SECRET456";
export const SECRET_SEED_URL = `${SEED_URL}?access_token=${PAGE_SECRET}`;
export const SEED_HTML = readFileSync(join(here, "../fixtures/tool-smoke.html"), "utf8");

export async function installSeed({ callTool, sc }) {
  const doc = sc(
    await callTool("intercept_add", {
      urlPattern: SEED_URL,
      action: { kind: "respond", status: 200, mimeType: "text/html", body: SEED_HTML },
    }),
  );
  // Same seed document, served at a URL carrying a secret query param.
  const page = sc(
    await callTool("intercept_add", {
      urlPattern: `${SEED_URL}?access_token=*`,
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
  return { docRuleId: doc.rule?.id, pageRuleId: page.rule?.id, apiRuleId: api.rule?.id };
}

/** Throws if any fixture secret appears in a tool result's text or structuredContent. */
export function assertNoSecret(r, tool, txt) {
  const blob = txt(r) + JSON.stringify(r.structuredContent ?? {});
  for (const s of [URL_SECRET, PAGE_SECRET]) {
    if (blob.includes(s)) throw new Error(`${tool} leaked ${s}`);
  }
}
