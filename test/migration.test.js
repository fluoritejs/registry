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
  migrate,
  reconcileStaging,
  cleanupTempBlobs,
  prepare,
  getStmt,
  blobPath,
} from "../src/db.js";
import { openTestDb } from "./helpers.js";

describe("Migration & recovery", () => {
  it("creates all tables", async () => {
    const { db, cleanup } = await openTestDb();
    try {
      await migrate(db);
      prepare(db);

      const tables = await db.unsafe(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
      );
      const names = tables.map((t) => t.table_name);
      assert.ok(names.includes("users"));
      assert.ok(names.includes("auth_tokens"));
      assert.ok(names.includes("automation_tokens"));
      assert.ok(names.includes("versions"));
      assert.ok(names.includes("notifications"));
      assert.ok(names.includes("webhooks"));
    } finally {
      await cleanup();
    }
  });

  it("promotes staging version when blob exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const { db, cleanup } = await openTestDb();
    try {
      await migrate(db);
      prepare(db);

      const user = await getStmt("createUser").get(
        "testuser",
        "Test",
        "hash",
        "normal",
        1,
      );
      const bp = blobPath(dir, "testuser", "ext", "1.0.0");
      mkdirSync(join(dir, "blobs", "testuser", "ext"), { recursive: true });
      writeFileSync(bp, "// extension code");

      await getStmt("createVersion").run(
        user.id,
        "ext",
        "1.0.0",
        "staging",
        "{}",
        bp,
        new Date().toISOString(),
        null,
      );

      await reconcileStaging(db);

      const v = await getStmt("getVersion").get("testuser", "ext", "1.0.0");
      assert.strictEqual(v.status, "pending");
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes staging version when blob is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const { db, cleanup } = await openTestDb();
    try {
      await migrate(db);
      prepare(db);

      const user = await getStmt("createUser").get(
        "testuser2",
        "Test2",
        "hash",
        "normal",
        1,
      );
      const bp = blobPath(dir, "testuser2", "ext", "2.0.0");

      await getStmt("createVersion").run(
        user.id,
        "ext",
        "2.0.0",
        "staging",
        "{}",
        bp,
        new Date().toISOString(),
        null,
      );

      await reconcileStaging(db);

      const v = await getStmt("getVersion").get("testuser2", "ext", "2.0.0");
      assert.strictEqual(v, undefined);
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promotes pending_delete versions that still have their blob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const { db, cleanup } = await openTestDb();
    try {
      await migrate(db);
      prepare(db);

      const user = await getStmt("createUser").get(
        "testuser3",
        "Test3",
        "hash",
        "normal",
        1,
      );
      const bp = blobPath(dir, "testuser3", "ext", "3.0.0");
      mkdirSync(join(dir, "blobs", "testuser3", "ext"), { recursive: true });
      writeFileSync(bp, "// extension code");

      await getStmt("createVersion").run(
        user.id,
        "ext",
        "3.0.0",
        "pending_delete",
        "{}",
        bp,
        new Date().toISOString(),
        null,
      );

      await reconcileStaging(db);

      const v = await getStmt("getVersion").get("testuser3", "ext", "3.0.0");
      assert.strictEqual(v, undefined);
      assert.ok(!existsSync(bp));
    } finally {
      await cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
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
