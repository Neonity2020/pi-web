"use client";

import type { MouseEvent } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import {
  markdownPreviewRehypePlugins,
  markdownPreviewRemarkPlugins,
  markdownUrlTransform,
} from "@/lib/markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { placeCaretFromPoint } from "@/lib/markdown-caret";
import { getFileApiUrl } from "@/lib/file-api-url";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";

/**
 * The one markdown rendering configuration Pi Web uses for documents.
 *
 * The read-only preview and the WYSIWYG editor deliberately share it: the
 * editor draws its blocks with the same components, so a rendered block and a
 * previewed document cannot drift apart. Anything the renderer rewrites — a
 * local link becoming an /api/files/... URL, a fenced block becoming a
 * CodeBlock — has to be reversible by the editor's serializer, which is why the
 * editor additionally keeps the original markdown target in a data attribute
 * (see `editable`).
 */
export interface MarkdownDocumentOptions {
  /** Directory of the rendered document, for resolving local targets. */
  fileDirectory: string;
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string, page?: number) => void;
  /**
   * The document is being edited: local targets keep their raw markdown form so
   * a save can write it back unchanged, and links place the caret instead of
   * navigating. See lib/markdown-caret.ts for why.
   */
  editable?: boolean;
}


export function markdownDocumentComponents({
  fileDirectory,
  cwd,
  sourceSessionId,
  onOpenFile,
  editable = false,
}: MarkdownDocumentOptions): Components {
  return {
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    pre({ children }) {
      // Render the code block directly — CodeBlock provides its own wrapping.
      // For non-mermaid blocks, pass through to default pre rendering.
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      delete props.node;
      if (editable) {
        return (
          <a
            href={href}
            {...props}
            data-md-href={href}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              // Cancelling the default mousedown keeps the browser from starting
              // a link activation, which would also discard the caret the click
              // is supposed to place.
              event.preventDefault();
              placeCaretFromPoint(event.clientX, event.clientY);
            }}
          >
            {children}
          </a>
        );
      }
      const linkedFile = onOpenFile
        ? resolveLocalFileHref(href, fileDirectory, cwd ?? fileDirectory)
        : null;
      if (!linkedFile || !onOpenFile) {
        return <a href={href} {...props}>{children}</a>;
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        event.preventDefault();
        onOpenFile(linkedFile, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      if (editable) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ""}
            {...props}
            data-md-href={typeof src === "string" ? src : undefined}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              placeCaretFromPoint(event.clientX, event.clientY);
            }}
          />
        );
      }
      const imagePath = typeof src === "string"
        ? resolveLocalFileHref(src, fileDirectory, cwd ?? fileDirectory)
        : null;
      const imageSrc = imagePath
        ? getFileApiUrl(imagePath, "read", sourceSessionId)
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
  };
}

/**
 * Render markdown with the shared stack. Both the read-only preview and the
 * editor draw their blocks through this component, so a previewed document and
 * an edited block cannot diverge in parsing, sanitizing or math handling.
 */
export function MarkdownDocument({
  source,
  options,
}: {
  source: string;
  options: MarkdownDocumentOptions;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownPreviewRemarkPlugins}
      rehypePlugins={markdownPreviewRehypePlugins}
      urlTransform={options.onOpenFile ? markdownUrlTransform : undefined}
      components={markdownDocumentComponents(options)}
    >
      {source}
    </ReactMarkdown>
  );
}
