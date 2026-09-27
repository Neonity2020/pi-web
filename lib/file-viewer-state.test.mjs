import assert from "node:assert/strict";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler").
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-viewer-state.ts");
}

test("a restored display mode wins over a stale open hint", async () => {
  const { resolveInitialFileDisplayMode } = await loadSubject();
  const state = {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 80,
    scrollLeft: 0,
  };

  assert.equal(resolveInitialFileDisplayMode(state, "diff"), "source");
});

test("the open hint is used only before viewer state has been saved", async () => {
  const { resolveInitialFileDisplayMode } = await loadSubject();
  assert.equal(resolveInitialFileDisplayMode(undefined, "diff"), "diff");
  assert.equal(resolveInitialFileDisplayMode(), "source");
});

test("only whole markdown files below the edit limit are editable", async () => {
  const { isMarkdownEditable } = await loadSubject();

  assert.equal(isMarkdownEditable("markdown", false, 1024), true);
  assert.equal(isMarkdownEditable("markdown", false, 2 * 1024 * 1024), true);
  assert.equal(isMarkdownEditable("markdown", false, 2 * 1024 * 1024 + 1), false);

  // A truncated preview would save back a file with everything past the
  // previewed window cut off.
  assert.equal(isMarkdownEditable("markdown", true, 1024), false);
  // Other languages have no WYSIWYG mode.
  assert.equal(isMarkdownEditable("html", false, 1024), false);
  assert.equal(isMarkdownEditable("text", false, 1024), false);
  assert.equal(isMarkdownEditable(undefined, false, undefined), false);
});
