// snapshot_diff: take a snapshot, mutate the DOM, snapshot again, diff the two
// latest persisted snapshots. (snapshot_take itself is covered by the runner.)
export async function run(ctx) {
  const { callTool, sc, t, assert } = ctx;

  await t("snapshot_diff", async () => {
    await callTool("snapshot_take", {});
    await callTool("script_evaluate", {
      expression:
        "const b=document.createElement('button');b.setAttribute('aria-label','diff-added');b.textContent='diff-added';document.body.appendChild(b);true",
    });
    await callTool("snapshot_take", {});
    const r = sc(await callTool("snapshot_diff", {}));
    const changed = (r.addedUids ?? 0) + (r.removedUids ?? 0) + (r.changedUids ?? 0);
    assert(changed > 0, `no diff (added=${r.addedUids} removed=${r.removedUids} changed=${r.changedUids})`);
    return `added=${r.addedUids}`;
  });
}
