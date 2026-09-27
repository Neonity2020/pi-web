import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler").
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-write.ts");
}

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-write-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  return { base, root };
}

test("accepts only a string content with a finite base stamp", async () => {
  const { parseFileWriteRequest } = await loadSubject();

  assert.deepEqual(parseFileWriteRequest({ content: "# t", baseMtimeMs: 12 }), {
    content: "# t",
    baseMtimeMs: 12,
  });
  assert.equal(parseFileWriteRequest(null), null);
  assert.equal(parseFileWriteRequest({ content: 5, baseMtimeMs: 12 }), null);
  // A missing stamp cannot be compared, so it must not be read as "no conflict".
  assert.equal(parseFileWriteRequest({ content: "# t" }), null);
  assert.equal(parseFileWriteRequest({ content: "# t", baseMtimeMs: Number.NaN }), null);
  assert.equal(parseFileWriteRequest({ content: "# t", baseMtimeMs: "12" }), null);
});

test("writes the content in place, preserving mode and inode", async () => {
  const { writeTextFileInPlace } = await loadSubject();
  const { base, root } = makeWorkspace();
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "# old", "utf8");
  fs.chmodSync(file, 0o644);
  const before = fs.statSync(file);

  const result = writeTextFileInPlace(file, "# new\n");

  assert.equal(fs.readFileSync(file, "utf8"), "# new\n");
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(result.size, 6);
  assert.ok(result.mtimeMs >= before.mtimeMs);
  fs.rmSync(base, { recursive: true, force: true });
});

test("refuses a save when the file on disk is newer than the loaded copy", async () => {
  const { hasFileChangedSince } = await loadSubject();

  assert.equal(hasFileChangedSince(1000, 1000), false);
  assert.equal(hasFileChangedSince(1000, 1001), true);
});

test("authorizes an existing file inside an allowed root", async (t) => {
  const { resolveWritableTextFile } = await loadSubject();
  const { base, root } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(root, "note.md");
  fs.writeFileSync(file, "# t", "utf8");

  // macOS resolves /var to /private/var, so the returned path is the realpath.
  const resolved = resolveWritableTextFile(file, new Set([root]));
  assert.deepEqual(resolved, { ok: true, path: fs.realpathSync(file) });
});

test("rejects a path outside every allowed root before touching the disk", async (t) => {
  const { resolveWritableTextFile } = await loadSubject();
  const { base, root } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, "secret.md");
  fs.writeFileSync(outside, "secret", "utf8");

  const resolved = resolveWritableTextFile(outside, new Set([root]));
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.status, 403);
  assert.equal(fs.readFileSync(outside, "utf8"), "secret");
});

test("never creates a missing target and never writes through a directory", async (t) => {
  const { resolveWritableTextFile } = await loadSubject();
  const { base, root } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const missing = resolveWritableTextFile(path.join(root, "absent.md"), new Set([root]));
  assert.equal(missing.ok === false && missing.status, 404);
  assert.equal(fs.existsSync(path.join(root, "absent.md")), false);

  const directory = resolveWritableTextFile(root, new Set([root]));
  assert.equal(directory.ok, false);
  assert.equal(directory.ok === false && directory.status, 400);
});

test("rejects a symlink inside an allowed root that points outside it", async (t) => {
  const { resolveWritableTextFile } = await loadSubject();
  const { base, root } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  const link = path.join(root, "link.md");
  fs.symlinkSync(path.join(outside, "secret.md"), link);

  const resolved = resolveWritableTextFile(link, new Set([root]));
  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.status, 403);
  assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "secret");
});

test("allows a symlink that resolves to another allowed root", async (t) => {
  const { resolveWritableTextFile } = await loadSubject();
  const { base, root } = makeWorkspace();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const other = path.join(base, "other");
  fs.mkdirSync(other);
  const file = path.join(other, "note.md");
  fs.writeFileSync(file, "# t", "utf8");
  const link = path.join(root, "note.md");
  fs.symlinkSync(file, link);

  const resolved = resolveWritableTextFile(link, new Set([root, other]));
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok === true && resolved.path, fs.realpathSync(file));
});
