// Page + session lifecycle: page_new/list/select/back/forward/reload/close and
// session_new. (page_navigate and session_close/list are covered by the runner.)
// Runs last because it churns the page set and active selection.
export async function run(ctx) {
  const { callTool, sc, t, assert } = ctx;

  let newPage;
  await t("page_new", async () => {
    const r = sc(await callTool("page_new", { background: true }));
    assert(typeof r.pageId === "string", "no pageId");
    newPage = r.pageId;
    return r.pageId;
  });

  await t("page_list", async () => {
    const r = sc(await callTool("page_list", {}));
    assert((r.pages?.length ?? 0) >= 2, `pages=${r.pages?.length}`);
    return `${r.pages.length} pages`;
  });

  await t("page_select", async () => {
    const r = sc(await callTool("page_select", { pageId: newPage }));
    assert(r.pageId === newPage, "select mismatch");
    return r.pageId;
  });

  // Build two committed history entries on the selected page before back/forward.
  await callTool("page_navigate", { url: "https://example.com/", pageId: newPage });
  await callTool("page_navigate", { url: "https://example.org/", pageId: newPage });

  await t("page_back", async () => {
    const r = sc(await callTool("page_back", { pageId: newPage }));
    assert(r.navigated === true, `navigated=${r.navigated}`);
    return r.url;
  });

  await t("page_forward", async () => {
    const r = sc(await callTool("page_forward", { pageId: newPage }));
    assert(r.navigated === true, `navigated=${r.navigated}`);
    return r.url;
  });

  await t("page_reload", async () => {
    const r = sc(await callTool("page_reload", { pageId: newPage }));
    return r.url ?? "reloaded";
  });

  await t("page_close", async () => {
    const r = sc(await callTool("page_close", { pageId: newPage }));
    assert(r.closedPageId === newPage, "close mismatch");
    return "closed";
  });

  await t("session_new", async () => {
    // Bound to this connection's own session; observable effect is a new page.
    const r = sc(await callTool("session_new", {}));
    assert(typeof r.pageId === "string", "no pageId from session_new");
    try { await callTool("page_close", { pageId: r.pageId }); } catch {}
    return r.pageId;
  });
}
