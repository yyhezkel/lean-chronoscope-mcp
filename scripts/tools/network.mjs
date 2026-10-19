// Network tools: network_wait_for, network_list, network_get, network_search.
// Relies on the seed page's fetch() to https://tool-smoke.test/api/data, which
// the interception layer answers — giving a real completed request to inspect.
// The seed also fetches /api/data?access_token=SECRET123; every tool's text AND
// structuredContent must have that value redacted (tool-smoke.test is external).
// The page itself is loaded at ?access_token=SECRET456, which also rides along
// in the document request URL and the fetch's Referer header.
import { SECRET_SEED_URL, URL_SECRET, assertNoSecret } from "./fixture.mjs";

const isSeedDoc = (x) => x.resourceType === "document" && x.url.startsWith("https://tool-smoke.test/");

export async function run(ctx) {
  const { callTool, sc, txt, t, assert } = ctx;

  const noSecret = (r, tool) => assertNoSecret(r, tool, txt);

  await t("network_wait_for", async () => {
    const r = sc(await callTool("network_wait_for", { urlContains: "api/data", timeoutMs: 8000 }));
    assert(r.matched === true, `no api/data request captured (waited ${r.waitedMs}ms)`);
    // Make sure the secret-bearing request is captured too before the leak checks.
    const sraw = await callTool("network_wait_for", { urlContains: "access_token", timeoutMs: 8000 });
    assert(sc(sraw).matched === true, "secret-param request not captured");
    noSecret(sraw, "network_wait_for");
    return `#${r.request?.id} status ${r.request?.status}`;
  });

  let rowId;
  let secretId;
  await t("network_list", async () => {
    const raw = await callTool("network_list", { urlContains: "tool-smoke", pageSize: 50 });
    const r = sc(raw);
    assert((r.rows?.length ?? 0) > 0, `no rows (total=${r.total})`);
    rowId = r.rows[0].id;
    noSecret(raw, "network_list");
    const secretRow = r.rows.find((x) => x.url.includes("access_token="));
    assert(secretRow, "secret-param row missing from list");
    assert(secretRow.url.includes("access_token=[REDACTED]"), `url not redacted: ${secretRow.url}`);
    secretId = secretRow.id;
    return `${r.rows.length} rows, secret redacted`;
  });

  await t("network_get", async () => {
    assert(rowId, "no row id from network_list");
    const r = sc(await callTool("network_get", { reqid: rowId, part: "all" }));
    assert(typeof r.url === "string" && r.url.includes("tool-smoke"), `url=${r.url}`);
    assert(secretId, "no secret row id from network_list");
    const raw = await callTool("network_get", { reqid: secretId, part: "all" });
    noSecret(raw, "network_get");
    assert(sc(raw).url.includes("access_token=[REDACTED]"), `url=${sc(raw).url}`);
    return `${r.url}; secret redacted`;
  });

  await t("network_search", async () => {
    const r = sc(await callTool("network_search", { query: "tool-smoke.test" }));
    assert((r.total ?? 0) >= 1, `total=${r.total}`);
    // FTS indexes the raw URL, so the secret still matches — but must not be echoed.
    const raw = await callTool("network_search", { query: URL_SECRET });
    assert((sc(raw).total ?? 0) >= 1, `secret search total=${sc(raw).total}`);
    noSecret(raw, "network_search");
    return `total=${r.total}; secret redacted`;
  });

  // Regression: the top-level document request fires before framenavigated
  // stamps the new nav id, so it used to fall outside the default (current-nav)
  // scope — network_list with no filters right after a navigate missed it.
  await t("network_list:document-after-navigate", async () => {
    const nav = sc(await callTool("page_navigate", { url: SECRET_SEED_URL }));
    assert(nav.status === 200, `navigate status=${nav.status}`);
    const r = sc(await callTool("network_list", {}));
    // URLs come back redacted, so match the seed document by host + type.
    const doc = (r.rows ?? []).find((x) => isSeedDoc(x));
    assert(doc, `no seed document row in default scope (total=${r.total}: ${(r.rows ?? []).map((x) => x.url).join(", ")})`);
    return `doc #${doc.id} in ${r.total} rows`;
  });

  // Regression: same-document navigations (pushState / hash) re-fire
  // framenavigated with the same loaderId; they used to open a new nav row, so
  // the default scope dropped everything the document had loaded so far.
  await t("network_list:same-document-nav", async () => {
    await callTool("page_navigate", { url: SECRET_SEED_URL });
    const w = sc(await callTool("network_wait_for", { urlContains: "api/data", timeoutMs: 8000 }));
    assert(w.matched === true, "seed api/data request not captured");
    sc(await callTool("script_evaluate", { expression: "history.pushState({}, '', '#x'); location.hash = 'y'; 1" }));
    sc(await callTool("script_evaluate", {
      expression: "fetch('https://tool-smoke.test/api/after-push').then((r) => r.status)",
    }));
    const w2 = sc(await callTool("network_wait_for", { urlContains: "api/after-push", timeoutMs: 8000 }));
    assert(w2.matched === true, "after-push request not captured");
    const r = sc(await callTool("network_list", { pageSize: 50 }));
    const urls = (r.rows ?? []).map((x) => x.url);
    assert((r.rows ?? []).some(isSeedDoc), `document missing: ${urls.join(", ")}`);
    assert(urls.some((u) => u.includes("api/data")), `seed api/data missing: ${urls.join(", ")}`);
    assert(urls.some((u) => u.includes("api/after-push")), `after-push missing: ${urls.join(", ")}`);
    return `${r.total} rows incl. doc + api/data + after-push`;
  });
}
