import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import reactSyntaxHighlighter from "react-syntax-highlighter";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const { Prism: SyntaxHighlighter } = reactSyntaxHighlighter;

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

for (const [name, nextName] of [
  ["ImageViewer", "formatDuration"],
  ["AudioViewer", "VideoViewer"],
  ["VideoViewer", "DocumentViewer"],
  ["DocumentViewer", "FileViewer"],
  ["TextFileViewer", null],
]) {
  test(`${name} pauses its watcher and synchronizes after connecting`, () => {
    const block = functionBlock(name, nextName);
    const guard = block.indexOf("if (!watchEnabled");
    const guardEnd = block.indexOf("return;", guard);
    const eventSource = block.indexOf("new EventSource", guard);
    const synchronize = block.indexOf("synchronize();", eventSource);

    assert.ok(guard >= 0, "watchEnabled guard missing");
    assert.ok(guardEnd > guard, "watchEnabled guard does not return");
    assert.ok(eventSource > guardEnd, "EventSource created before watchEnabled guard");
    assert.ok(synchronize > eventSource, "connected synchronization missing");
    assert.match(block, /\}, \[[^\]]*watchEnabled[^\]]*\]\);/);
  });
}

test("TextFileViewer never live-refreshes markdown", () => {
  const block = functionBlock("TextFileViewer", null);

  // The editor keeps the user's copy, and an agent editing the same file is a
  // conflict the user resolves on save, so markdown gets no watcher at all.
  assert.match(block, /if \(!watchEnabled \|\| data\?\.language === "markdown"\) return;/);
  assert.match(block, /sourceSessionId, watchEnabled, data\?\.language\]/);
});

test("the markdown editor is offered only for whole, small-enough files", () => {
  const block = functionBlock("TextFileViewer", null);

  // A truncated preview would save back a file with its tail cut off, and the
  // editor reads the whole document rather than the 256KB preview chunk.
  assert.match(block, /const markdownEditable = isMarkdownEditable\(/);
  assert.match(block, /\.\.\.\(markdownEditable \? \["edit" as const\] : \[\]\)/);
  assert.match(block, /getFileApiUrl\(filePath, "read", sourceSessionId, \{ full: 1 \}\)/);
  assert.match(block, /<MarkdownEditor/);
});

test("FileViewer forwards watcher state to every viewer implementation", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.equal(block.match(/watchEnabled=\{watchEnabled\}/g)?.length, 5);
});

test("TextFileViewer snapshots and restores lightweight tab state", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\)/);
  assert.match(block, /displayMode: requestedInitialDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.displayMode = nextDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.wrapLines = next/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = event\.currentTarget\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = event\.currentTarget\.scrollLeft/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer keeps first-mount preview eligibility across Strict Effects cleanup", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /defaultPreviewEligibleRef = useRef\(/);
  assert.match(block, /defaultPreviewEligibleRef\.current[\s\S]*updateDisplayMode\("preview"\)/);
});

test("markdown table tokens stay inline despite Tailwind's table utility", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.match(html, /class="token table[ "]/);
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});
