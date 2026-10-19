// Network tools: network_wait_for, network_list, network_get, network_search.
// Relies on the seed page's fetch() to https://tool-smoke.test/api/data, which
// the interception layer answers — giving a real completed request to inspect.
export async function run(ctx) {
  const { callTool, sc, t, assert, state } = ctx;

  await t("network_wait_for", async () => {
    const r = sc(await callTool("network_wait_for", { urlContains: "api/data", timeoutMs: 8000 }));
    assert(r.matched === true, `no api/data request captured (waited ${r.waitedMs}ms)`);
    return `#${r.request?.id} status ${r.request?.status}`;
  });

  let rowId;
  await t("network_list", async () => {
    const r = sc(await callTool("network_list", { urlContains: "tool-smoke", pageSize: 50 }));
    assert((r.rows?.length ?? 0) > 0, `no rows (total=${r.total})`);
    rowId = r.rows[0].id;
    return `${r.rows.length} rows`;
  });

  await t("network_get", async () => {
    assert(rowId, "no row id from network_list");
    const r = sc(await callTool("network_get", { reqid: rowId, part: "all" }));
    assert(typeof r.url === "string" && r.url.includes("tool-smoke"), `url=${r.url}`);
    return r.url;
  });

  await t("network_search", async () => {
    const r = sc(await callTool("network_search", { query: "tool-smoke.test" }));
    assert((r.total ?? 0) >= 1, `total=${r.total}`);
    return `total=${r.total}`;
  });

  // Regression: the top-level document request fires before framenavigated
  // stamps the new nav id, so it used to fall outside the default (current-nav)
  // scope — network_list with no filters right after a navigate missed it.
  await t("network_list:document-after-navigate", async () => {
    const nav = sc(await callTool("page_navigate", { url: state.seedUrl }));
    assert(nav.status === 200, `navigate status=${nav.status}`);
    const r = sc(await callTool("network_list", {}));
    const doc = (r.rows ?? []).find((x) => x.url === state.seedUrl && x.resourceType === "document");
    assert(doc, `no document row for ${state.seedUrl} in default scope (total=${r.total}: ${(r.rows ?? []).map((x) => x.url).join(", ")})`);
    return `doc #${doc.id} in ${r.total} rows`;
  });

  // Regression: same-document navigations (pushState / hash) re-fire
  // framenavigated with the same loaderId; they used to open a new nav row, so
  // the default scope dropped everything the document had loaded so far.
  await t("network_list:same-document-nav", async () => {
    await callTool("page_navigate", { url: state.seedUrl });
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
    assert((r.rows ?? []).some((x) => x.url === state.seedUrl && x.resourceType === "document"), `document missing: ${urls.join(", ")}`);
    assert(urls.some((u) => u.includes("api/data")), `seed api/data missing: ${urls.join(", ")}`);
    assert(urls.some((u) => u.includes("api/after-push")), `after-push missing: ${urls.join(", ")}`);
    return `${r.total} rows incl. doc + api/data + after-push`;
  });
}
