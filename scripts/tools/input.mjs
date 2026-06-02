// Input tools: click, hover, type, fill_form, key, scroll, drag, upload_file.
// Each resolves element UIDs from a fresh accessibility snapshot (elements are
// given unique aria-labels in the seed page) and verifies its effect via
// script_evaluate where an observable post-condition exists.
import { uidByLabel } from "./harness.mjs";

export async function run(ctx) {
  const { callTool, sc, txt, t, assert, sleep, state } = ctx;

  // Reuse the runner's first (full) snapshot text. Taking a fresh snapshot here
  // would return "(unchanged since rev N)" via the change-detect memo and have
  // no [uid] lines to parse. The element uids stay valid because no newer
  // snapshot is persisted until after the input tests finish.
  const snap = state.snapText || txt(await callTool("snapshot_take", {}));
  const uid = (label) => {
    const u = uidByLabel(snap, label);
    if (!u) throw new Error(`uid for "${label}" not found in snapshot`);
    return u;
  };
  const evalVal = async (expr) => sc(await callTool("script_evaluate", { expression: expr })).value;

  await t("click", async () => {
    const r = sc(await callTool("click", { uid: uid("smoke-btn") }));
    await sleep(50);
    assert((await evalVal("window.__clicked === true")) === true, "onclick did not fire");
    return `${r.durationMs}ms`;
  });

  await t("hover", async () => {
    const r = sc(await callTool("hover", { uid: uid("smoke-btn") }));
    assert(typeof r.durationMs === "number", "no durationMs");
    return `${r.durationMs}ms`;
  });

  await t("type", async () => {
    await callTool("type", { uid: uid("smoke-text"), text: "hello" });
    const v = await evalVal("document.getElementById('txt').value");
    assert(v === "hello", `value=${v}`);
    return `value=${v}`;
  });

  await t("key", async () => {
    // Field still focused from `type`; Backspace should drop the last char.
    await callTool("key", { keys: "Backspace" });
    const v = await evalVal("document.getElementById('txt').value");
    assert(v === "hell", `value=${v}`);
    return `value=${v}`;
  });

  await t("fill_form", async () => {
    await callTool("fill_form", {
      fields: [
        { kind: "text", uid: uid("smoke-text"), value: "filled" },
        { kind: "select", uid: uid("smoke-select"), value: "b" },
        { kind: "check", uid: uid("smoke-check"), value: true },
      ],
    });
    const state2 = await evalVal(
      "JSON.stringify({t:document.getElementById('txt').value,s:document.getElementById('sel').value,c:document.getElementById('chk').checked})",
    );
    const parsed = JSON.parse(state2);
    assert(parsed.t === "filled" && parsed.s === "b" && parsed.c === true, `form=${state2}`);
    return "text+select+check";
  });

  await t("scroll", async () => {
    await callTool("scroll", { direction: "down", amount: 800 });
    await sleep(50);
    const y = await evalVal("window.scrollY");
    assert(y > 0, `scrollY=${y}`);
    return `scrollY=${y}`;
  });

  await t("drag", async () => {
    // No reliable drop semantics for arbitrary divs; assert the tool completes.
    const r = sc(await callTool("drag", { fromUid: uid("drag-src"), toUid: uid("drag-dst") }));
    assert(typeof r.durationMs === "number", "no durationMs");
    return `${r.durationMs}ms`;
  });

  await t("upload_file", async () => {
    const r = sc(await callTool("upload_file", { uid: uid("smoke-file"), paths: [state.uploadPath] }));
    assert(r.fileCount === 1, `fileCount=${r.fileCount}`);
    const n = await evalVal("document.getElementById('file').files.length");
    assert(n === 1, `files.length=${n}`);
    return `${r.fileCount} file`;
  });
}
