import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

/**
 * End-to-end coverage for the markdown WYSIWYG editor.
 *
 * Two entry points:
 *   - `npm run test:e2e:editor` runs it standalone against a dev server on
 *     127.0.0.1:30141 (E2E_ORIGIN overrides), creating its own project and
 *     session;
 *   - e2e/run.mjs calls checkMarkdownEditor() with its own server, project and
 *     session, so the editor is covered by the normal `npm run test:e2e` run.
 */

const EDITOR_FIXTURE = [
  "---",
  "title: Editor notes",
  "tags: [a, b]",
  "---",
  "",
  "# Heading one",
  "",
  "A paragraph with **bold** and a [local link](./guide/start.md).",
  "",
  "- item one",
  "  - nested item",
  "",
  "| col a | col b |",
  "| ----- | ----- |",
  "| 1     | 2     |",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "Trailing paragraph.",
  "",
].join("\n");

/** Wait until the save button reports the last save succeeded. */
async function waitSaved(page) {
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll(".md-editor-toolbar button")]
      .find((node) => node.textContent?.trim() === "Saved");
    return !!button;
  }, { timeout: 20_000 });
}

export async function checkMarkdownEditor({ page, base, project, sessionId, label = "notes.md" }) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    // A refused save is the conflict path being exercised on purpose.
    if (message.type() !== "error" || /409 \(Conflict\)/.test(message.text())) return;
    errors.push(message.text());
  });

  const doc = join(project, label);
  const initial = EDITOR_FIXTURE;
  writeFileSync(doc, initial);
  const inode = statSync(doc).ino;

  await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  const fileLink = page.getByTitle(doc.replace(/\\/g, "/"), { exact: true });
  await fileLink.click();
  await page.waitForSelector("#file-panel.right-panel-open", { timeout: 20_000 });
  await page.waitForSelector(".file-viewer-toolbar", { timeout: 20_000 });

  // Markdown keeps opening as a preview unless the user chooses the editor.
  await page.waitForSelector(".markdown-file-preview", { timeout: 20_000 });
  console.log("PASS: markdown opens in preview mode:", await page.locator(".markdown-file-preview h1").first().innerText());

  // No markdown watcher: the live indicator reads as not watching.
  const indicator = await page.locator(".file-viewer-live-indicator").getAttribute("title");
  assert.ok(!/Live sync/i.test(indicator ?? ""), `markdown must not live-sync (got "${indicator}")`);
  console.log("PASS: markdown does not live-refresh");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector(".md-editor", { timeout: 20_000 });
  assert.equal(await page.locator(".md-editor-block").count(), 7, "editor splits the document into blocks");
  console.log("PASS: editor loads 7 blocks (frontmatter, heading, paragraph, list, table, code, paragraph)");

  // Rich text: caret stays where the user typed, and the markdown is recovered.
  const paragraph = page.locator(".md-editor-block-editable", { hasText: "A paragraph with" }).first();
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited inline.");
  await delay(600);
  assert.equal(await page.locator(".md-editor-dirty").count(), 1, "editing marks the document dirty");
  await page.keyboard.press("ControlOrMeta+s");
  await waitSaved(page);

  const saved = readFileSync(doc, "utf8");
  assert.ok(saved.includes("Edited inline."), "inline edit persisted");
  assert.ok(saved.startsWith("---\ntitle: Editor notes\ntags: [a, b]\n---\n\n# Heading one\n\n"), "frontmatter preserved verbatim");
  assert.ok(saved.includes("[local link](./guide/start.md)"), "relative link preserved");
  assert.ok(saved.includes("- item one\n  - nested item"), "nested list untouched");
  assert.ok(saved.includes("```js\nconst x = 1;\n```"), "fence language untouched");
  assert.equal(statSync(doc).ino, inode, "save keeps the file's inode");
  // The only intended changes are the appended sentence; everything else must
  // survive byte for byte.
  assert.equal(
    saved.replace(" [local link](./guide/start.md). Edited inline.", " [local link](./guide/start.md)."),
    initial,
  );
  console.log("PASS: rich-text edit, frontmatter, links, lists and fences round-trip exactly");

  // A structural edit: the heading becomes an h2.
  const heading = page.locator(".md-editor-block-editable", { hasText: "Heading one" }).first();
  await heading.click();
  await page.locator(".md-editor-target-button", { hasText: "H2" }).click();
  await delay(400);
  await page.keyboard.press("ControlOrMeta+s");
  await waitSaved(page);
  assert.ok(readFileSync(doc, "utf8").includes("## Heading one"), "heading converted to h2");
  console.log("PASS: block-type conversion saves as markdown syntax");

  // Reload: file tabs live in memory, so reopening shows the saved document.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#session-sidebar", { timeout: 20_000 });
  await page.getByTitle(doc.replace(/\\/g, "/"), { exact: true }).click();
  await page.waitForSelector(".markdown-file-preview", { timeout: 20_000 });
  const reopened = await page.locator("#file-panel").innerText();
  assert.match(reopened, /Edited inline\./, "reload must show the saved text");
  assert.match(reopened, /Heading one/, "reload must show the saved heading");
  console.log("PASS: saved document survives a reload");

  // Conflict: an external write after load must be refused, not overwritten.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector(".md-editor", { timeout: 20_000 });
  const trailing = page.locator(".md-editor-block-editable", { hasText: "Trailing paragraph" }).first();
  await trailing.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" External change lost?");
  await delay(600);
  const mtime = statSync(doc).mtime;
  writeFileSync(doc, readFileSync(doc, "utf8").replace("Trailing paragraph.", "Trailing paragraph.\n\nAgent added this."));
  // A newer stamp is what makes the save a conflict, so push it forward.
  utimesSync(doc, new Date(mtime.getTime() + 5_000), new Date(mtime.getTime() + 5_000));
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForSelector(".md-editor-conflict", { timeout: 20_000 });
  const onDisk = readFileSync(doc, "utf8");
  assert.ok(onDisk.includes("Agent added this."), "agent edit must survive the refused save");
  assert.ok(!onDisk.includes("External change lost?"), "the refused save must not reach disk");
  console.log("PASS: external change is refused instead of overwritten");

  // Overwriting is then an explicit choice.
  await page.getByRole("button", { name: "Overwrite disk version" }).click();
  await page.waitForFunction(() => !document.querySelector(".md-editor-conflict"), { timeout: 20_000 });
  const overwritten = readFileSync(doc, "utf8");
  assert.ok(!overwritten.includes("Agent added this."), "overwrite replaces the disk version");
  assert.ok(overwritten.includes("External change lost?"), "overwrite writes the editor's copy");
  console.log("PASS: overwrite is an explicit choice");

  // Source editing for a block whose markup cannot round-trip.
  await page.locator(".md-editor-block-static", { hasText: "col a" }).first().hover();
  await page.locator(".md-editor-source-button").first().click();
  const textarea = page.locator("textarea.md-editor-source").first();
  await textarea.fill("| col a | col b |\n| ----- | ----- |\n| 9     | 8     |");
  // ⌘S from inside the source editor: the key event bubbles to the editor root.
  await textarea.press("ControlOrMeta+s");
  await waitSaved(page);
  assert.ok(readFileSync(doc, "utf8").includes("| 9     | 8     |"), "source-edited table saved");
  console.log("PASS: table is edited as source");

  // Preview mode still renders the same document.
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.waitForSelector(".markdown-file-preview");
  assert.match(await page.locator(".markdown-file-preview h2").first().innerText(), /Heading one/);
  console.log("PASS: preview renders the edited document");

  // Enter creates a block; Backspace removes it again while it is still empty.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.waitForSelector(".md-editor", { timeout: 20_000 });
  const blockCount = await page.locator(".md-editor-block").count();
  await page.locator(".md-editor-block-editable").last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await delay(300);
  assert.equal(await page.locator(".md-editor-block").count(), blockCount + 1, "Enter adds a block");
  await page.keyboard.type("added by Enter");
  await delay(400);
  // A Backspace at the start of a non-empty block must not merge blocks (separate
  // contentEditable roots cannot be merged), so the text stays where it is.
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await delay(250);
  assert.equal(await page.locator(".md-editor-block").count(), blockCount + 1, "a non-empty block survives");
  assert.match(await page.locator(".md-editor-block-editable").last().innerText(), /added by Enter/);
  // An empty block does go away, which is how a stray Enter is undone.
  await page.keyboard.press("Enter");
  await delay(250);
  assert.equal(await page.locator(".md-editor-block").count(), blockCount + 2, "Enter adds another block");
  await page.keyboard.press("Backspace");
  await delay(250);
  assert.equal(await page.locator(".md-editor-block").count(), blockCount + 1, "an empty block is removed");

  await page.locator(".md-editor-block-editable").last().click();
  await page.keyboard.press("ControlOrMeta+s");
  await waitSaved(page);
  const final = readFileSync(doc, "utf8");
  assert.ok(final.includes("added by Enter"), "Enter block saved");
  assert.ok(!final.includes("\n\n\n"), "no blank-line churn");
  assert.ok(final.endsWith("\n"), "file keeps its trailing newline");
  console.log("PASS: Enter/Backspace block editing round-trips");

  assert.deepEqual(errors, [], `browser errors: ${errors.join("\n")}`);
}

// Standalone mode: own browser, project and session, against a local dev server.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.E2E_ORIGIN || "http://127.0.0.1:30141";
  const project = mkdtempSync(join(tmpdir(), "md-editor-"));
  mkdirSync(project, { recursive: true });

  // The explorer is rooted at a session's cwd, so the document needs one. It is
  // written into the real sessions tree (a standalone run has no temp agent dir)
  // and removed again at the end.
  const sessionsRoot = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, "sessions")
    : join(homedir(), ".pi", "agent", "sessions");
  const sessionId = randomUUID();
  const sessionDir = join(sessionsRoot, "-" + project.split("/").filter(Boolean).join("-"));
  const sessionFile = join(sessionDir, `2026-09-27T00-00-00-000Z_${sessionId}.jsonl`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-27T00:00:00.000Z", cwd: project }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-27T00:00:00.000Z", message: { role: "user", content: "markdown editor e2e" } }),
  ].join("\n") + "\n");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await checkMarkdownEditor({ page, base, project, sessionId });
    console.log("\nOK — markdown editor end-to-end verified");
  } finally {
    await browser.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(sessionFile, { force: true });
  }
}
