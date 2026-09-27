import fs from "fs";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";

/**
 * Save path for the markdown editor.
 *
 * Reads are guarded by the allowed-roots set (lib/file-access.ts) and by a
 * chunked read that cannot exhaust memory. A write must be held to the same
 * roots, but the rules are stricter in the places where a mistake destroys
 * user data:
 *
 *   - the target must already exist, so an editor can never create files or
 *     overwrite a directory;
 *   - symbolic links are resolved before the containment check, so a link
 *     inside an allowed root cannot redirect a save outside it (the same
 *     protection the upload route applies to directories);
 *   - the client sends the mtimeMs it read the file at, and a save that would
 *     clobber a newer on-disk version — for example an edit the coding agent
 *     made in the background — is refused so the user can decide.
 */

export interface FileWriteRequest {
  content: string;
  baseMtimeMs: number;
}

export type WriteTargetResolution =
  | { ok: true; path: string }
  | { ok: false; status: number; error: string };

export function parseFileWriteRequest(value: unknown): FileWriteRequest | null {
  if (!value || typeof value !== "object") return null;
  const { content, baseMtimeMs } = value as Record<string, unknown>;
  if (typeof content !== "string") return null;
  // A missing or non-finite stamp cannot be compared, and treating it as
  // "no conflict" would silently drop the conflict protection.
  if (typeof baseMtimeMs !== "number" || !Number.isFinite(baseMtimeMs) || baseMtimeMs < 0) return null;
  return { content, baseMtimeMs };
}

/**
 * Authorize an existing file as a write target.
 *
 * The lexical check runs first so a path outside every root never reaches the
 * filesystem; `existsSync`/`statSync` then establish that the target is a
 * regular file rather than a directory, and the realpath check re-runs
 * containment on the resolved path so symlinks are held to the same roots.
 */
export function resolveWritableTextFile(
  target: string,
  allowedRoots: Set<string>,
): WriteTargetResolution {
  if (!isPathWithinRoots(target, allowedRoots)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 400, error: "Not a file" };
  }

  let realTarget: string;
  const realRoots = new Set<string>();
  try {
    realTarget = fs.realpathSync(target);
    for (const root of allowedRoots) {
      try {
        realRoots.add(fs.realpathSync(root));
      } catch {
        // Ignore stale roots that no longer exist.
      }
    }
  } catch {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (!isExistingPathWithinRoots(realTarget, realRoots)) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  return { ok: true, path: realTarget };
}

/** True when the file on disk is newer than the copy the editor loaded. */
export function hasFileChangedSince(baseMtimeMs: number, currentMtimeMs: number): boolean {
  return baseMtimeMs !== currentMtimeMs;
}

/**
 * Write text in place, keeping the file's inode, mode and ownership.
 *
 * Not lib/atomic-file.ts: that helper writes a temporary file with mode 0600
 * and renames over the target, which would tighten the permissions of an
 * ordinary document, replace its inode (breaking editor tooling and external
 * watchers that key on it) and lose hard links. A crash mid-write is the
 * accepted trade-off; the mtime guard above is what protects content.
 */
export function writeTextFileInPlace(
  filePath: string,
  content: string,
): { mtimeMs: number; size: number } {
  fs.writeFileSync(filePath, content, "utf8");
  const stat = fs.statSync(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}
