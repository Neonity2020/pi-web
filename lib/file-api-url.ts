import { encodeFilePathForApi } from "./file-paths";

/**
 * Build the /api/files URL for one file.
 *
 * Kept in lib so both the viewer and the markdown document renderer resolve a
 * path to the same URL — the WYSIWYG editor writes the resolved URLs back out
 * as document-relative hrefs, so the two sides must agree byte for byte.
 */
export function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch" | "write",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
