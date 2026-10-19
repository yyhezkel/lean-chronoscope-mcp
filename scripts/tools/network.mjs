// Network tools: network_wait_for, network_list, network_get, network_search.
// Relies on the seed page's fetch() to https://tool-smoke.test/api/data, which
// the interception layer answers — giving a real completed request to inspect.
// The seed also fetches /api/data?access_token=SECRET123; every tool's text AND
// structuredContent must have that value redacted (tool-smoke.test is external).
// The page itself is loaded at ?access_token=SECRET456, which also rides along
// in the document request URL and the fetch's Referer header.
import { URL_SECRET, assertNoSecret } from "./fixture.mjs";

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
}
