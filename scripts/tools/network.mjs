// Network tools: network_wait_for, network_list, network_get, network_search.
// Relies on the seed page's fetch() to https://tool-smoke.test/api/data, which
// the interception layer answers — giving a real completed request to inspect.
export async function run(ctx) {
  const { callTool, sc, t, assert } = ctx;

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
}
