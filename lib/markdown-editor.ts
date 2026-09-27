import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import TurndownService from "turndown";
import { gfm as turndownGfm } from "turndown-plugin-gfm";
import { getRelativeFilePath } from "./file-paths";
import { filePathFromApiSegments } from "./paths";

/**
 * Block model for the markdown WYSIWYG editor.
 *
 * The editor renders each top-level node through the same ReactMarkdown stack
 * as the read-only preview, so what the user types is styled by the code that
 * styles the document. Two consequences drive this module:
 *
 *   1. Parsing uses exactly the renderer's pipeline (remark-parse + the three
 *      plugins the preview uses), so the blocks the editor splits are the blocks
 *      the renderer draws. A plain parser would disagree about, say, GFM tables
 *      and the editor would treat each table line as its own paragraph.
 *   2. The document is never reassembled from a serializer. Each block keeps the
 *      text that preceded it, so saving rewrites only the blocks the user
 *      touched and preserves the exact whitespace everywhere else.
 */

export type EditorBlockKind =
  | "frontmatter"
  | "heading"
  | "paragraph"
  | "blockquote"
  | "list"
  | "table"
  | "code"
  | "math"
  | "thematicBreak"
  | "html"
  | "unknown";

export interface EditorBlock {
  /** Stable per position: `kind-index` in the parsed document. */
  key: string;
  kind: EditorBlockKind;
  /** Markdown source of this block, exactly as parsed. */
  source: string;
  /** Text between the previous block and this one, kept verbatim. */
  gapBefore: string;
}

export interface ParsedDocument {
  blocks: EditorBlock[];
  /** Text after the last block, kept verbatim (usually a trailing newline). */
  trailing: string;
}

/** Coarse mdast node kinds the editor distinguishes. */
const NODE_KINDS: Record<string, EditorBlockKind> = {
  yaml: "frontmatter",
  heading: "heading",
  paragraph: "paragraph",
  blockquote: "blockquote",
  list: "list",
  table: "table",
  code: "code",
  math: "math",
  inlineMath: "math",
  thematicBreak: "thematicBreak",
  html: "html",
  definition: "html",
};

/**
 * Blocks whose rendered form can be edited directly as rich text. Everything
 * else (tables, code fences, math, frontmatter) is edited as source, because
 * converting that HTML back to markdown loses information the user cannot see:
 * table alignment, fence language, KaTeX macros.
 */
const INLINE_EDITABLE: ReadonlySet<EditorBlockKind> = new Set<EditorBlockKind>([
  "paragraph",
  "heading",
  "blockquote",
  "list",
]);

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .use(remarkFrontmatter, ["yaml"] as any)
  .use(remarkMath);

export function parseEditorBlocks(markdown: string): ParsedDocument {
  const tree = parser.parse(markdown) as {
    children: Array<{ type: string; position?: { start: { offset: number }; end: { offset: number } } }>;
  };
  const blocks: EditorBlock[] = [];
  let cursor = 0;

  tree.children.forEach((node, index) => {
    const start = node.position?.start.offset ?? cursor;
    const end = Math.max(node.position?.end.offset ?? start, start);
    const kind = NODE_KINDS[node.type] ?? "unknown";
    blocks.push({
      key: `${kind}-${index}`,
      kind,
      source: markdown.slice(start, end),
      gapBefore: markdown.slice(cursor, start),
    });
    cursor = end;
  });

  return { blocks, trailing: markdown.slice(cursor) };
}

/** Rebuild the document. Only edited blocks differ from the parsed text. */
export function assembleDocument(document: ParsedDocument): string {
  return document.blocks.map((block) => `${block.gapBefore}${block.source}`).join("") + document.trailing;
}

export function isInlineEditableBlock(kind: EditorBlockKind): boolean {
  return INLINE_EDITABLE.has(kind);
}

function rekey(blocks: EditorBlock[]): EditorBlock[] {
  return blocks.map((block, index) => ({ ...block, key: `${block.kind}-${index}` }));
}

export function replaceBlockSource(
  document: ParsedDocument,
  index: number,
  source: string,
): ParsedDocument {
  return {
    ...document,
    blocks: document.blocks.map((block, blockIndex) => (
      blockIndex === index ? { ...block, source } : block
    )),
  };
}

export function insertBlockAfter(
  document: ParsedDocument,
  index: number,
  kind: EditorBlockKind,
  source: string,
): ParsedDocument {
  const inserted: EditorBlock = { key: `${kind}-added`, kind, source, gapBefore: "\n\n" };
  const blocks = index >= 0
    ? [...document.blocks.slice(0, index + 1), inserted, ...document.blocks.slice(index + 1)]
    : [inserted];
  return { ...document, blocks: rekey(blocks) };
}

export function deleteBlock(document: ParsedDocument, index: number): ParsedDocument {
  if (index < 0 || index >= document.blocks.length) return document;
  return { ...document, blocks: rekey(document.blocks.filter((_, blockIndex) => blockIndex !== index)) };
}

export type BlockTarget = "paragraph" | "heading1" | "heading2" | "heading3" | "list" | "blockquote" | "code";

/** Strip the syntax of the block's current kind, leaving its inner text. */
function stripBlockSyntax(source: string, kind: EditorBlockKind): string {
  switch (kind) {
    case "heading":
      return source.replace(/^ {0,3}#{1,6}[ \t]+/, "");
    case "blockquote":
      return source.split("\n").map((line) => line.replace(/^ {0,3}>[ \t]?/, "")).join("\n");
    case "list":
      return source
        .split("\n")
        .map((line) => line.replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])[ \t]+/, (_match, indent: string) => indent))
        .join("\n");
    case "code": {
      const fenced = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/.exec(source);
      return fenced ? fenced[2] : source;
    }
    default:
      return source;
  }
}

/** Re-apply the syntax of the target kind. */
function applyBlockSyntax(text: string, target: BlockTarget): string {
  const lines = text.split("\n");
  switch (target) {
    case "paragraph":
      return text;
    case "heading1":
    case "heading2":
    case "heading3":
      return `${"#".repeat(Number(target.slice(-1)))} ${text.trim()}`;
    case "list":
      return lines.map((line) => (line.trim() ? `- ${line}` : line)).join("\n");
    case "blockquote":
      return lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
  }
}

/** Turn a block into another kind, keeping its text. */
export function convertBlock(
  document: ParsedDocument,
  index: number,
  target: BlockTarget,
): ParsedDocument {
  const block = document.blocks[index];
  if (!block) return document;
  const kind: EditorBlockKind = target.startsWith("heading")
    ? "heading"
    : target as ParagraphLikeTarget;
type ParagraphLikeTarget = "paragraph" | "list" | "blockquote" | "code";
  const source = applyBlockSyntax(stripBlockSyntax(block.source, block.kind), target);
  return { ...document, blocks: rekey(document.blocks.map((item, itemIndex) => (
    itemIndex === index ? { ...item, kind, source } : item
  ))) };
}

/** Raise or lower a heading by one level (1…3), padding with paragraph marks. */
export function shiftHeading(
  document: ParsedDocument,
  index: number,
  direction: -1 | 1,
): ParsedDocument {
  const block = document.blocks[index];
  if (!block || block.kind !== "heading") return document;
  const current = Math.min(/^ {0,3}(#{1,6})/.exec(block.source)?.[1].length ?? 1, 3);
  const next = Math.min(Math.max(current + direction, 1), 3) as 1 | 2 | 3;
  const source = applyBlockSyntax(stripBlockSyntax(block.source, "heading"), `heading${next}`);
  return { ...document, blocks: document.blocks.map((item, itemIndex) => (
    itemIndex === index ? { ...item, source } : item
  )) };
}

// ---------------------------------------------------------------------------
// HTML → markdown
//
// Inline blocks are edited as rendered HTML, so their markdown has to be
// recovered from the DOM. Turndown is that conversion, with rules that exist
// only because the preview resolves things the browser can use:
//
//   - local image/link hrefs become /api/files/... URLs, which must be turned
//     back into document-relative paths or every save would rewrite them;
//   - KaTeX output carries the original TeX in an <annotation>, which is the
//     only way to recover `$…$` from the rendered math.
// ---------------------------------------------------------------------------

export interface BlockSerializerOptions {
  /** Directory of the edited document, used to rebuild relative hrefs. */
  fileDirectory?: string;
}

const FILE_API_PREFIX = "/api/files/";

function hasClass(node: unknown, className: string): boolean {
  const element = node as { classList?: { contains(value: string): boolean } };
  return element?.classList?.contains?.(className) === true;
}

function tagName(node: unknown): string {
  return String((node as { nodeName?: string })?.nodeName ?? "").toUpperCase();
}

function attributeValue(node: unknown, name: string): string {
  return String((node as { getAttribute?(n: string): string | null })?.getAttribute?.(name) ?? "");
}

/**
 * Read the TeX back out of rendered KaTeX. Index access rather than for…of:
 * the DOM in Node is domino, whose NodeList is not iterable.
 */
function texAnnotation(node: unknown): string | null {
  const matches = (node as {
    getElementsByTagName?(name: string): { length: number; item(index: number): Element | null } | null;
  })?.getElementsByTagName?.("annotation");
  for (let index = 0; index < (matches?.length ?? 0); index++) {
    const match = matches!.item(index);
    if (String(match?.getAttribute?.("encoding") ?? "") !== "application/x-tex") continue;
    const text = String(match?.textContent ?? "");
    if (text.trim()) return text;
  }
  return null;
}

/** The original markdown target, preserved by the editor's renderer. */
function originalHref(node: unknown): string | null {
  return attributeValue(node, "data-md-href") || null;
}

/** Rebuild a document-relative href from a resolved /api/files/... URL. */
function apiUrlToRelativeHref(url: string, fileDirectory?: string): string | null {
  if (!url.startsWith(FILE_API_PREFIX)) return null;
  let segments: string[];
  try {
    const parsed = new URL(url, "http://pi-web.invalid");
    segments = parsed.pathname.slice(FILE_API_PREFIX.length).split("/").flatMap((segment) => {
      try {
        return [decodeURIComponent(segment)];
      } catch {
        return [segment];
      }
    });
  } catch {
    return null;
  }
  const filePath = filePathFromApiSegments(segments.filter(Boolean));
  if (!filePath) return null;
  return fileDirectory ? getRelativeFilePath(filePath, fileDirectory) : filePath;
}

export function createBlockSerializer({ fileDirectory }: BlockSerializerOptions = {}) {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  service.use(turndownGfm);

  // Rendered KaTeX is decorative except for the annotation it carries, so both
  // math rules ignore their content and read the TeX directly. The display rule
  // has to run before the inline one: a display block contains a nested .katex.
  service.addRule("katexDisplay", {
    filter: (node: unknown) => hasClass(node, "katex-display"),
    replacement: (content: string, node: unknown) => {
      const tex = texAnnotation(node);
      return tex ? `\n$$${tex}$$\n` : content;
    },
  });
  service.addRule("katexInline", {
    filter: (node: unknown) => tagName(node) === "SPAN" && hasClass(node, "katex"),
    replacement: (content: string, node: unknown) => {
      const tex = texAnnotation(node);
      return tex ? `$${tex}$` : content;
    },
  });

  service.addRule("localImage", {
    filter: (node: unknown) => tagName(node) === "IMG" && attributeValue(node, "src").startsWith(FILE_API_PREFIX),
    replacement: (_content: string, node: unknown) => {
      const src = attributeValue(node, "src");
      const preserved = originalHref(node);
      const target = apiUrlToRelativeHref(src, fileDirectory);
      // A preserved target is absolute-file-URL-like only when it was one; the
      // resolved URL is turned back into a document-relative path.
      const source = preserved ?? target;
      const alt = attributeValue(node, "alt");
      const title = attributeValue(node, "title");
      return source ? `![${alt}](${source}${title ? ` "${title}"` : ""})` : "";
    },
  });

  service.addRule("localLink", {
    filter: (node: unknown) => tagName(node) === "A" && attributeValue(node, "href").startsWith(FILE_API_PREFIX),
    replacement: (content: string, node: unknown) => {
      const href = attributeValue(node, "href");
      const preserved = originalHref(node);
      const url = preserved ?? apiUrlToRelativeHref(href, fileDirectory);
      const title = attributeValue(node, "title");
      return url ? `[${content}](${url}${title ? ` "${title}"` : ""})` : content;
    },
  });

  return {
    serialize(html: string): string {
      return service
        .turndown(html)
        // Turndown pads list markers out to four columns; one space is the form
        // the rest of the document uses, and a task-list checkbox gets the same
        // treatment. Nested-item indentation is untouched.
        .replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)]))[ \t]+/gm, "$1 ")
        .replace(/^([ \t]*(?:[-*+]|\d{1,9}[.)]) \[[ xX]\])[ \t]+/gm, "$1 ")
        .replace(/\n{3,}/g, "\n\n");
    },
  };
}

const serializers = new Map<string, ReturnType<typeof createBlockSerializer>>();

/** Serializers are pure per file directory, so one instance is reused. */
export function getBlockSerializer(fileDirectory?: string) {
  const key = fileDirectory ?? "";
  let serializer = serializers.get(key);
  if (!serializer) {
    serializer = createBlockSerializer({ fileDirectory });
    // The viewer edits one document at a time; keep the cache from growing.
    if (serializers.size > 4) serializers.clear();
    serializers.set(key, serializer);
  }
  return serializer;
}
