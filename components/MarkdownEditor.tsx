"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  assembleDocument,
  convertBlock,
  deleteBlock,
  getBlockSerializer,
  insertBlockAfter,
  isInlineEditableBlock,
  parseEditorBlocks,
  replaceBlockSource,
  shiftHeading,
  type BlockTarget,
  type EditorBlock,
  type ParsedDocument,
} from "@/lib/markdown-editor";
import { MarkdownDocument, type MarkdownDocumentOptions } from "./markdown-document";
import { placeCaretFromPoint, placeCaretInElement } from "@/lib/markdown-caret";

/**
 * Result protocol between the editor and the viewer's save call. The two
 * failures are separate variants, not one with a free-form reason, so a
 * conflict can carry the new stamp without callers having to cast.
 */
export type MarkdownSaveResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; reason: "conflict"; mtimeMs: number }
  | { ok: false; reason: "error"; message: string };

interface Props {
  /** Directory of the doc, used to resolve and restore local links. */
  fileDirectory: string;
  cwd?: string;
  sourceSessionId?: string | null;
  initialContent: string;
  /** mtimeMs of the loaded file: the base stamp a save is validated against. */
  baseMtimeMs: number;
  onSave: (content: string, baseMtimeMs: number) => Promise<MarkdownSaveResult>;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Lets the viewer surface an unsaved-changes marker on the tab. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Re-read the document from disk after a conflict, discarding the buffer. */
  onRequestReload?: () => void;
}

type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "failed";

const BLOCK_TARGETS: BlockTarget[] = ["paragraph", "heading1", "heading2", "heading3", "list", "blockquote", "code"];

/**
 * WYSIWYG editor for markdown documents.
 *
 * Structure: the doc is a list of blocks, each rendered by the same
 * ReactMarkdown pipeline as the read-only preview. Rich-text blocks are plain
 * contentEditable elements holding that rendered markup; every input is
 * serialized back to markdown with turndown (see lib/markdown-editor.ts), which
 * is what makes the view and the file agree without a third representation.
 * Blocks whose markup cannot be reversed losslessly — tables, fenced code, math,
 * frontmatter — render read-only and are edited as source.
 *
 * Enter/Backspace act at markdown level rather than letting the browser split
 * or merge nodes: separate contentEditable roots cannot be merged by a
 * keystroke, and a browser-inserted <div> serializes as a block the user never
 * asked for.
 */
export function MarkdownEditor({
  fileDirectory,
  cwd,
  sourceSessionId,
  initialContent,
  baseMtimeMs,
  onSave,
  onOpenFile,
  onDirtyChange,
  onRequestReload,
}: Props) {
  const { t } = useI18n();
  const [doc, setDocument] = useState<ParsedDocument>(() => parseEditorBlocks(initialContent));
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [sourceEditingIndex, setSourceEditingIndex] = useState<number | null>(null);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [error, setError] = useState<string | null>(null);
  const [conflictMtimeMs, setConflictMtimeMs] = useState<number | null>(null);

  // A block's rendered markup is mounted once and left alone (see BlockRender).
  // Structural changes that keep a block's key — a heading level shift, a block
  // type conversion — bump its version so it remounts with the new syntax.
  const [renderVersions, setRenderVersions] = useState<Record<string, number>>({});
  const committedRef = useRef(initialContent);
  const baseMtimeRef = useRef(baseMtimeMs);
  // The viewer re-mounts this editor when the mode changes, passing the stamp
  // the file was loaded with. A save that succeeded advances the stamp, and it
  // has to be adopted here too or the next save looks like a conflict.
  useEffect(() => {
    baseMtimeRef.current = baseMtimeMs;
  }, [baseMtimeMs]);
  const blockElements = useRef(new Map<string, HTMLDivElement>());
  const lastSerializedHtml = useRef(new Map<string, string>());
  const dirty = assembleDocument(doc) !== committedRef.current;

  // The editor keeps the original markdown target on links and images so a save
  // writes back what was in the file instead of the resolved API URL.
  const documentOptions = useMemo<MarkdownDocumentOptions>(() => ({
    fileDirectory,
    cwd,
    sourceSessionId,
    onOpenFile,
    editable: true,
  }), [cwd, fileDirectory, onOpenFile, sourceSessionId]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Leaving or reloading the page must not silently drop the edit.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const updateBlockSource = useCallback((index: number, source: string) => {
    setDocument((current) => replaceBlockSource(current, index, source));
    setStatus("dirty");
  }, []);

  const remountBlock = useCallback((block: EditorBlock | undefined) => {
    if (!block) return;
    setRenderVersions((current) => ({ ...current, [block.key]: (current[block.key] ?? 0) + 1 }));
  }, []);

  // A click that lands on the block itself — its padding, or the paragraph's
  // margin — gives the browser a block-level caret at the very start of the
  // block, where the End key moves nothing and typing prepends to the block.
  // Re-resolve the caret to the text under the pointer so editing starts where
  // the user aimed, exactly as it does in a plain textarea.
  const handleEditableClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const element = event.currentTarget;
    if (placeCaretFromPoint(event.clientX, event.clientY)) return;
    placeCaretInElement(element, false);
  }, []);

  const focusBlock = useCallback((key: string, atEnd = true) => {
    // The block only exists after React commits the new doc.
    requestAnimationFrame(() => {
      const element = blockElements.current.get(key);
      if (!element) return;
      element.focus();
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(!atEnd);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }, []);

  const handleBlockInput = useCallback((block: EditorBlock, index: number, element: HTMLDivElement) => {
    const html = element.innerHTML;
    const previous = lastSerializedHtml.current.get(block.key);
    if (previous === html) return;
    lastSerializedHtml.current.set(block.key, html);

    const nextSource = getBlockSerializer(fileDirectory).serialize(html).replace(/\s+$/, "");
    if (nextSource === block.source) return;
    updateBlockSource(index, nextSource);
  }, [fileDirectory, updateBlockSource]);

  const insertBlockAfterCurrent = useCallback((index: number, kind: EditorBlock["kind"], source: string) => {
    setDocument((current) => insertBlockAfter(current, index, kind, source));
    setStatus("dirty");
  }, []);

  const save = useCallback(async () => {
    // Flush a possibly-debounced block before reading the doc.
    for (const [key, element] of blockElements.current) {
      const index = doc.blocks.findIndex((block) => block.key === key);
      if (index >= 0) handleBlockInput(doc.blocks[index], index, element);
    }
    const content = assembleDocument(doc);
    setStatus("saving");
    setError(null);
    const result = await onSave(content, baseMtimeRef.current);
    if (result.ok) {
      committedRef.current = content;
      baseMtimeRef.current = result.mtimeMs;
      setConflictMtimeMs(null);
      setStatus("saved");
      return;
    }
    if (result.reason === "conflict") {
      setConflictMtimeMs(result.mtimeMs);
      setStatus("dirty");
      return;
    }
    setError(result.message);
    setStatus("failed");
  }, [doc, handleBlockInput, onSave]);

  const discard = useCallback(() => {
    setDocument(parseEditorBlocks(committedRef.current));
    lastSerializedHtml.current.clear();
    setConflictMtimeMs(null);
    setError(null);
    setStatus("clean");
  }, []);

  const overwriteDiskVersion = useCallback(async () => {
    if (conflictMtimeMs == null) return;
    const content = assembleDocument(doc);
    setStatus("saving");
    const result = await onSave(content, conflictMtimeMs);
    if (result.ok) {
      committedRef.current = content;
      baseMtimeRef.current = result.mtimeMs;
      setConflictMtimeMs(null);
      setStatus("saved");
      return;
    }
    if (result.reason === "conflict") {
      setConflictMtimeMs(result.mtimeMs);
      setStatus("dirty");
      return;
    }
    setError(result.message);
    setStatus("failed");
  }, [conflictMtimeMs, doc, onSave]);

  const handleBlockKeyDown = useCallback((block: EditorBlock, index: number, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const isMeta = event.metaKey || event.ctrlKey;

    if (isMeta && !event.shiftKey && ["b", "i", "u"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      document.execCommand(event.key.toLowerCase() === "u" ? "underline" : event.key.toLowerCase());
      return;
    }

    if (isMeta && event.key.toLowerCase() === "e") {
      // Inline code has no execCommand verb; wrap the selection in <code> and
      // let the serializer turn it into backticks.
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const code = document.createElement("code");
      code.append(range.extractContents());
      range.insertNode(code);
      selection.removeAllRanges();
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      // html/body are overscroll-behavior:none, and Chromium never issues the
      // caret move for these keys as a result. Move the caret to the start or
      // end of the block's content ourselves.
      event.preventDefault();
      const element = blockElements.current.get(block.key);
      if (element) placeCaretInElement(element, event.key === "Home");
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const element = blockElements.current.get(block.key);
      if (element) handleBlockInput(block, index, element);

      if (block.kind === "list") {
        // A new item belongs to the list, so the block keeps its own syntax.
        setDocument((current) => ({
          ...current,
          blocks: current.blocks.map((item, itemIndex) => (
            itemIndex === index ? { ...item, source: `${item.source.replace(/\s+$/, "")}\n- ` } : item
          )),
        }));
        setStatus("dirty");
        focusBlock(block.key);
        return;
      }

      insertBlockAfterCurrent(index, "paragraph", "");
      // Focus the new block whether or not it ends the document: without this,
      // Enter on the last block leaves the caret in the old one and the next
      // keystrokes are appended there instead of starting the new block.
      focusBlock(`paragraph-${index + 1}`);
      return;
    }

    if (event.key === "Backspace") {
      const element = blockElements.current.get(block.key);
      const selection = window.getSelection();
      const atStart = !!selection && selection.isCollapsed && selection.focusOffset === 0
        && element?.contains(selection.anchorNode);
      if (atStart) {
        if (element && element.textContent?.trim()) {
          // Merging across contentEditable roots is not something a browser can
          // do, so a caret at the start of a non-empty block does nothing here.
          return;
        }
        event.preventDefault();
        setDocument((current) => deleteBlock(current, index));
        setStatus("dirty");
        const previousKey = doc.blocks[index - 1]?.key;
        if (previousKey) focusBlock(previousKey);
      }
      return;
    }

    if (event.key === "Tab" && block.kind === "list") {
      event.preventDefault();
      // Indentation is a list-structure edit; the caret is not needed.
      setDocument((current) => ({
        ...current,
        blocks: current.blocks.map((item, itemIndex) => {
          if (itemIndex !== index) return item;
          const indent = event.shiftKey ? -1 : 1;
          const lines = item.source.split("\n");
          const caret = caretLineIndex(blockElements.current.get(block.key));
          const line = lines[caret] ?? lines[0];
          lines[caret] = indent > 0 ? `  ${line}` : line.replace(/^ {1,2}/, "");
          return { ...item, source: lines.join("\n") };
        }),
      }));
      setStatus("dirty");
    }
  }, [doc.blocks, focusBlock, handleBlockInput, insertBlockAfterCurrent]);

  const applyTarget = useCallback((target: BlockTarget) => {
    if (focusedIndex == null) return;
    const block = doc.blocks[focusedIndex];
    setDocument((current) => convertBlock(current, focusedIndex, target));
    remountBlock(block);
    setStatus("dirty");
  }, [doc.blocks, focusedIndex, remountBlock]);

  const shiftFocusedHeading = useCallback((direction: -1 | 1) => {
    if (focusedIndex == null) return;
    const block = doc.blocks[focusedIndex];
    setDocument((current) => shiftHeading(current, focusedIndex, direction));
    remountBlock(block);
    setStatus("dirty");
  }, [doc.blocks, focusedIndex, remountBlock]);

  const focusedBlock = focusedIndex == null ? null : doc.blocks[focusedIndex] ?? null;

  // ⌘S is handled at the root, not on a block: after using the toolbar the
  // focus sits on a button, and a key handler on the block would miss it.
  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    void save();
  };

  return (
    <div className="md-editor" onKeyDown={handleRootKeyDown}>
      <div className="md-editor-toolbar">
        <button
          type="button"
          className="file-viewer-mode-button"
          onClick={() => void save()}
          disabled={!dirty || status === "saving"}
          title={t("editor.save")}
        >
          {status === "saving" ? t("editor.saving") : status === "saved" ? t("editor.saved") : t("editor.saveShort")}
        </button>
        <button
          type="button"
          className="file-viewer-mode-button"
          onClick={discard}
          disabled={!dirty}
          title={t("editor.discard")}
        >
          {t("editor.discard")}
        </button>
        {dirty && <span className="md-editor-dirty" title={t("editor.dirty")} aria-label={t("editor.dirty")} />}

        <div className="md-editor-block-actions">
          <span className="md-editor-toolbar-label">{t("i18n.edit")}</span>
          {BLOCK_TARGETS.map((target) => (
            <button
              key={target}
              type="button"
              className="file-viewer-mode-button md-editor-target-button"
              aria-pressed={focusedBlock ? matchesTarget(focusedBlock, target) : false}
              onClick={() => applyTarget(target)}
              disabled={focusedIndex == null}
              title={target}
            >
              {target === "paragraph" ? "¶"
                : target.startsWith("heading") ? `H${target.slice(-1)}`
                : target === "list" ? "•"
                : target === "blockquote" ? "❝"
                : "</>"}
            </button>
          ))}
          {focusedBlock?.kind === "heading" && (
            <>
              <button type="button" className="file-viewer-mode-button" onClick={() => shiftFocusedHeading(-1)}>H−</button>
              <button type="button" className="file-viewer-mode-button" onClick={() => shiftFocusedHeading(1)}>H+</button>
            </>
          )}
          <button
            type="button"
            className="file-viewer-mode-button"
            onClick={() => document.execCommand("bold")}
            title="Bold"
          >B</button>
          <button
            type="button"
            className="file-viewer-mode-button"
            onClick={() => document.execCommand("italic")}
            title="Italic"
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className="file-viewer-mode-button"
            onClick={() => document.execCommand("strikethrough")}
            title="Strikethrough"
          >
            <s>S</s>
          </button>
        </div>
      </div>

      {error && <div className="md-editor-banner md-editor-error">{t("editor.failed", { reason: error })}</div>}
      {conflictMtimeMs != null && (
        <div className="md-editor-banner md-editor-conflict">
          <div>
            <strong>{t("editor.conflictTitle")}</strong>
            <div className="md-editor-conflict-body">{t("editor.conflictBody")}</div>
          </div>
          <div className="md-editor-conflict-actions">
            <button
              type="button"
              className="file-viewer-mode-button"
              onClick={() => (onRequestReload ? onRequestReload() : discard())}
            >
              {t("editor.conflictReload")}
            </button>
            <button type="button" className="file-viewer-mode-button" onClick={() => void overwriteDiskVersion()}>
              {t("editor.conflictOverwrite")}
            </button>
          </div>
        </div>
      )}

      <div className="md-editor-scroll markdown-body">
        {doc.blocks.map((block, index) => {
          const editable = isInlineEditableBlock(block.kind);
          const isSourceEditing = sourceEditingIndex === index;
          if (!editable) {
            return (
              <div className="md-editor-block md-editor-block-static" key={block.key}>
                {isSourceEditing ? (
                  <textarea
                    className="md-editor-source"
                    value={block.source}
                    autoFocus
                    onChange={(event) => updateBlockSource(index, event.target.value)}
                    onBlur={() => setSourceEditingIndex(null)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setSourceEditingIndex(null);
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className="md-editor-source-button"
                      onClick={() => setSourceEditingIndex(index)}
                      title={t("editor.editBlock")}
                    >
                      {t("editor.editBlock")}
                    </button>
                    <BlockMarkdown block={block} options={documentOptions} />
                  </>
                )}
              </div>
            );
          }

          return (
            <div
              key={`${block.key}:${renderVersions[block.key] ?? 0}`}
              ref={(element) => {
                if (element) blockElements.current.set(block.key, element);
                else blockElements.current.delete(block.key);
              }}
              className="md-editor-block md-editor-block-editable"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              tabIndex={0}
              onFocus={() => setFocusedIndex(index)}
              onClick={handleEditableClick}
              onInput={(event) => handleBlockInput(block, index, event.currentTarget)}
              onKeyDown={(event) => handleBlockKeyDown(block, index, event)}
            >
              <BlockRender source={block.source} kind={block.kind} options={documentOptions} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The rendered body of one block, mounted once.
 *
 * This is the piece that makes rich-text editing safe. While the caret sits in
 * a contentEditable element, React must never patch that element's DOM: it
 * reorders text nodes by its own diff, and the browser then continues typing in
 * whatever node landed under the caret — typing into `<strong>world</strong>`
 * ended up inside the element and the saved file came out scrambled. Locking the
 * source here keeps this component's output identical across every keystroke,
 * so React's reconciliation finds nothing to change and leaves the DOM alone.
 *
 * The editor's document state still tracks each keystroke (through the parent's
 * serializer), so saving and the dirty flag stay correct.
 */
function BlockRender({
  source,
  kind,
  options,
}: {
  source: string;
  kind: EditorBlock["kind"];
  options: MarkdownDocumentOptions;
}) {
  const [mountedSource] = useState(source);
  const [mountedKind] = useState(kind);

  // Frontmatter is stripped by the render pipeline and shown as a metadata card
  // in the preview, so the editor keeps it as raw YAML: it belongs to the file.
  if (mountedKind === "frontmatter") {
    return <pre className="md-editor-frontmatter">{mountedSource}</pre>;
  }
  return <MarkdownDocument source={mountedSource} options={options} />;
}

function matchesTarget(block: EditorBlock, target: BlockTarget): boolean {
  if (target === "paragraph") return block.kind === "paragraph";
  if (target.startsWith("heading")) {
    if (block.kind !== "heading") return false;
    const level = /^ {0,3}(#{1,6})/.exec(block.source)?.[1].length ?? 1;
    return level === Number(target.slice(-1));
  }
  return block.kind === target;
}

/** Which source line of a block the caret is on, for list indentation. */
function caretLineIndex(element: HTMLDivElement | undefined): number {
  const selection = window.getSelection();
  if (!element || !selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0).cloneRange();
  const lines = element.textContent ?? "";
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().split("\n").length - 1 < lines.split("\n").length
    ? Math.max(0, before.toString().split("\n").length - 1)
    : 0;
}

function BlockMarkdown({
  block,
  options,
}: {
  block: EditorBlock;
  options: MarkdownDocumentOptions;
}) {
  // Frontmatter is stripped by the render pipeline and shown as a metadata card
  // in the preview, so the editor keeps it as raw YAML: it belongs to the file.
  if (block.kind === "frontmatter") {
    return <pre className="md-editor-frontmatter">{block.source}</pre>;
  }
  return <MarkdownDocument source={block.source} options={options} />;
}
