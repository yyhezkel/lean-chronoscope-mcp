// Interception tools: intercept_add, intercept_list, intercept_remove. Adds a
// self-contained throwaway rule and removes it (the seed-serving rules are
// installed/removed separately by the control runner).
export async function run(ctx) {
  const { callTool, sc, t, assert } = ctx;

  let ruleId;
  await t("intercept_add", async () => {
    const r = sc(
      await callTool("intercept_add", {
        urlPattern: "https://api.example.test/*",
        action: { kind: "respond", status: 418, mimeType: "application/json", body: '{"hi":"mock"}' },
      }),
    );
    assert(r.rule?.id, "no rule id returned");
    ruleId = r.rule.id;
    return ruleId;
  });

  await t("intercept_list", async () => {
    const r = sc(await callTool("intercept_list", {}));
    assert((r.rules ?? []).some((x) => x.id === ruleId), `rule ${ruleId} not in list`);
    return `count=${r.count}`;
  });

  await t("intercept_remove", async () => {
    const r = sc(await callTool("intercept_remove", { id: ruleId }));
    assert(r.removed === true, "removed !== true");
    return "removed";
  });
}
