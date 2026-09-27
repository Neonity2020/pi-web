import { TEXT_EDIT_MAX_BYTES } from "./file-types";

export type FileViewerDisplayMode = "source" | "preview" | "edit" | "diff";

// "edit" is only offered for markdown files by the viewer itself; a restored
// "edit" state for any other kind is simply not reachable through the UI.
// The editor never persists unsaved content — re-entering edit mode reloads the
// document from disk, so a refresh cannot resurrect stale edits.

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  wrapLines: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}

/**
 * Whether a file may be opened in the WYSIWYG markdown editor.
 *
 * The editor loads and rewrites the whole file, so the two conditions are hard
 * requirements rather than preferences: only markdown is editable, and a file
 * the viewer had to truncate (or that is simply too large) can never be saved
 * back without destroying everything past the previewed window.
 */
export function isMarkdownEditable(
  language: string | undefined,
  truncated: boolean | undefined,
  size: number | undefined,
): boolean {
  if (language !== "markdown") return false;
  if (truncated) return false;
  if (size == null || size > TEXT_EDIT_MAX_BYTES) return false;
  return true;
}
