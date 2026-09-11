import { describe, it } from "node:test";
import assert from "node:assert";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openDb,
  migrate,
  reconcileStaging,
  cleanupTempBlobs,
  prepare,
  getStmt,
  blobPath,
} from "../src/db.js";

describe("Migration & recovery", () => {
  it("creates all tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "migration-"));
    const db = openDb(join(dir, "test.sqlite"));
    migrate(db);
    prepare(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    const names = tables
      .map((t) => t.name)
      .filter((n) => !n.startsWith("sqlite"));
    assert.ok(names.includes("users"));
    assert.ok(names.includes("auth_tokens"));
    assert.ok(names.includes("automation_tokens"));
    assert.ok(names.includes("versions"));
    assert.ok(names.includes("notifications"));
    assert.ok(names.includes("webhooks"));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes staging version when blob exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const db = openDb(join(dir, "test.sqlite"));
    migrate(db);
    prepare(db);

    const user = getStmt("createUser").run(
      "testuser",
      "Test",
      "hash",
      "normal",
      1,
    );
    const bp = blobPath(dir, "testuser", "ext", "1.0.0");
    mkdirSync(join(dir, "blobs", "testuser", "ext"), { recursive: true });
    writeFileSync(bp, "// extension code");

    getStmt("createVersion").run(
      user.lastInsertRowid,
      "ext",
      "1.0.0",
      "staging",
      "{}",
      bp,
      new Date().toISOString(),
      null,
    );

    reconcileStaging(db, dir);

    const v = getStmt("getVersion").get("testuser", "ext", "1.0.0");
    assert.strictEqual(v.status, "pending");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes staging version when blob is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const db = openDb(join(dir, "test.sqlite"));
    migrate(db);
    prepare(db);

    const user = getStmt("createUser").run(
      "testuser2",
      "Test2",
      "hash",
      "normal",
      1,
    );
    const bp = blobPath(dir, "testuser2", "ext", "2.0.0");

    getStmt("createVersion").run(
      user.lastInsertRowid,
      "ext",
      "2.0.0",
      "staging",
      "{}",
      bp,
      new Date().toISOString(),
      null,
    );

    reconcileStaging(db, dir);

    const v = getStmt("getVersion").get("testuser2", "ext", "2.0.0");
    assert.strictEqual(v, undefined);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cleans up orphaned temp blob files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
    const blobsDir = join(dir, "blobs");
    mkdirSync(join(blobsDir, "user", "ext"), { recursive: true });
    writeFileSync(join(blobsDir, "user", "ext", ".tmp-abc123"), "temp");
    writeFileSync(join(blobsDir, "user", "ext", "1.0.0.js"), "real");

    cleanupTempBlobs(dir);

    assert.ok(!existsSync(join(blobsDir, "user", "ext", ".tmp-abc123")));
    assert.ok(existsSync(join(blobsDir, "user", "ext", "1.0.0.js")));
    rmSync(dir, { recursive: true, force: true });
  });

  it("cleans up orphaned staging blob files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
    const blobsDir = join(dir, "blobs");
    mkdirSync(join(blobsDir, "user", "ext"), { recursive: true });
    writeFileSync(
      join(blobsDir, "user", "ext", "1.0.0.staging-0123456789abcdef"),
      "temp",
    );
    writeFileSync(join(blobsDir, "user", "ext", "1.0.0.js"), "real");

    cleanupTempBlobs(dir);

    assert.ok(
      !existsSync(
        join(blobsDir, "user", "ext", "1.0.0.staging-0123456789abcdef"),
      ),
    );
    assert.ok(existsSync(join(blobsDir, "user", "ext", "1.0.0.js")));
    rmSync(dir, { recursive: true, force: true });
  });
});
