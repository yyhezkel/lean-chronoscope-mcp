// IndexedDB tools: list_databases, query, clear. The seed page created a
// `smokeDb` database with a `things` store holding 2 rows. Must run while the
// seed page is the active page (IDB is read from the active page's origin).
export async function run(ctx) {
  const { callTool, sc, t, assert, sleep } = ctx;

  await sleep(200); // give the seed page's IDB writes time to commit

  await t("indexeddb_list_databases", async () => {
    const r = sc(await callTool("indexeddb_list_databases", {}));
    const names = (r.databases ?? []).map((d) => d.name);
    assert(names.includes("smokeDb"), `dbs=[${names.join(",")}]`);
    return names.join(",");
  });

  await t("indexeddb_query", async () => {
    const r = sc(await callTool("indexeddb_query", { database: "smokeDb", store: "things" }));
    assert(r.count === 2, `count=${r.count}`);
    return `count=${r.count}`;
  });

  await t("indexeddb_clear", async () => {
    await callTool("indexeddb_clear", { database: "smokeDb", store: "things" });
    const after = sc(await callTool("indexeddb_query", { database: "smokeDb", store: "things" }));
    assert(after.count === 0, `count after clear=${after.count}`);
    return "store cleared";
  });
}
