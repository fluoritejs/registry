import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";
import { extractManifest } from "../src/manifest.js";
import { getStmt, blobPath, reconcileStaging } from "../src/db.js";
import { CONFIG_DEFAULTS, setConfig } from "../src/config.js";

const VALID_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "valid-manifest.js"),
  "utf8",
);
const SAMPLE_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "sample-extension.js"),
  "utf8",
);
const MALFORMED_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "malformed-meta.js"),
  "utf8",
);
const COMPILED_SOURCE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "compiled-extension.js"),
  "utf8",
);

describe("Manifest extraction", () => {
  const pattern = CONFIG_DEFAULTS.publishing.packageIdPattern;
  setConfig(CONFIG_DEFAULTS);

  it("extracts a valid manifest", () => {
    const manifest = extractManifest(VALID_SOURCE, pattern);
    assert.strictEqual(manifest.id, "test-ext");
    assert.strictEqual(manifest.name, "Test Extension");
    assert.strictEqual(manifest.version, "2.1.0");
    assert.strictEqual(manifest.license, "Apache-2.0");
  });

  it("extracts a manifest from fluorite-compiler output", () => {
    const manifest = extractManifest(COMPILED_SOURCE, pattern);
    assert.strictEqual(manifest.id, "helloworld");
    assert.strictEqual(manifest.name, "It works!");
    assert.strictEqual(manifest.version, "0.1.0");
    assert.strictEqual(manifest.license, "LGPL-2.1");
  });

  it("rejects malformed source without executing side effects", () => {
    delete globalThis.__fluoriteTestSentinel;
    let threw = false;
    try {
      extractManifest(MALFORMED_SOURCE, pattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("No Fluorite manifest"));
    }
    assert.ok(threw, "Should have thrown for malformed source");
    assert.strictEqual(
      globalThis.__fluoriteTestSentinel,
      undefined,
      "malformed source must never be evaluated",
    );
  });

  it("rejects invalid version", () => {
    const source = `var Fluorite = { manifest: { id: 'test', name: 'T', version: 'not-semver', license: 'MIT', description: 'd' } };`;
    let threw = false;
    try {
      extractManifest(source, pattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("Invalid version"));
    }
    assert.ok(threw);
  });

  it("rejects invalid extension id", () => {
    const source = `var Fluorite = { manifest: { id: 'invalid id!', name: 'T', version: '1.0.0', license: 'MIT', description: 'd' } };`;
    let threw = false;
    try {
      extractManifest(source, pattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("Invalid extension id"));
    }
    assert.ok(threw);
  });

  it("rejects duplicate manifest fields", () => {
    const source = `var Fluorite = { manifest: { id: 'dup', name: 'T', version: '1.0.0', version: '2.0.0', license: 'MIT', description: 'd' } };`;
    let threw = false;
    try {
      extractManifest(source, pattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Duplicate "version"'));
    }
    assert.ok(threw);
  });

  it("rejects repeated Fluorite.manifest definitions", () => {
    const source = `var Fluorite = { manifest: { id: 'dup', name: 'T', version: '1.0.0', license: 'MIT', description: 'd' } }; Fluorite.manifest = { id: 'dup', name: 'T', version: '1.0.0', license: 'MIT', description: 'd' };`;
    let threw = false;
    try {
      extractManifest(source, pattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("Duplicate Fluorite.manifest"));
    }
    assert.ok(threw);
  });
});

describe("Extensions - review disabled", () => {
  let env, userToken;

  before(async () => {
    env = await createTestEnv(
      {},
      { publishing: { firstPublishRequiresReview: false } },
    );
    await signup(env.app, "revadmin", "password123");
    const userRes = await signup(env.app, "revuser", "password123");
    userToken = userRes.body.token;
  });

  after(() => env.cleanup());

  it("untrusted publish goes live when review is disabled", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@revuser/hello-world/versions",
      {
        body: SAMPLE_SOURCE,
        headers: {
          ...authHeaders(userToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, "published");
    assert.ok(res.body.publishedAt);
  });
});

describe("Extensions - trusted publish", () => {
  let env, trustedToken;

  before(async () => {
    env = await createTestEnv();
    const res = await signup(env.app, "trustedowner", "password123");
    trustedToken = res.body.token;
  });

  after(() => env.cleanup());

  it("trusted user publish goes directly to published", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@trustedowner/hello-world/versions",
      {
        body: SAMPLE_SOURCE,
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.version, "1.0.0");
    assert.strictEqual(res.body.status, "published");
  });

  it("publishes fluorite-compiler output directly", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@trustedowner/helloworld/versions",
      {
        body: COMPILED_SOURCE,
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.id, "helloworld");
    assert.strictEqual(res.body.version, "0.1.0");
    assert.strictEqual(res.body.status, "published");

    const jsRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@trustedowner/helloworld/versions/0.1.0",
      { headers: { Accept: "application/javascript" } },
    );
    assert.strictEqual(jsRes.status, 200);
    assert.ok(typeof jsRes.body === "string");
    assert.ok(jsRes.body.includes("Scratch.extensions.register"));
  });

  it("latest version resolves by semver across yank/un-yank, not publish order", async () => {
    const makeSource = (version) =>
      `var Fluorite = { manifest: { id: 'semver-pkg', name: 'Semver Test', version: '${version}', license: 'MIT', description: 'd' } };`;

    const res1 = await request(
      env.app,
      "POST",
      "/v0/extensions/@trustedowner/semver-pkg/versions",
      {
        body: makeSource("1.0.0"),
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res1.status, 201);
    assert.strictEqual(res1.body.status, "published");

    const res2 = await request(
      env.app,
      "POST",
      "/v0/extensions/@trustedowner/semver-pkg/versions",
      {
        body: makeSource("2.0.0"),
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res2.status, 201);
    assert.strictEqual(res2.body.status, "published");

    const yankRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@trustedowner/semver-pkg/versions/2.0.0/yank",
      {
        body: JSON.stringify({ yanked: true }),
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(yankRes.status, 200);
    assert.strictEqual(yankRes.body.yanked, true);

    const res15 = await request(
      env.app,
      "POST",
      "/v0/extensions/@trustedowner/semver-pkg/versions",
      {
        body: makeSource("1.5.0"),
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res15.status, 201);
    assert.strictEqual(res15.body.status, "published");

    const unyankRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@trustedowner/semver-pkg/versions/2.0.0/yank",
      {
        body: JSON.stringify({ yanked: false }),
        headers: {
          ...authHeaders(trustedToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(unyankRes.status, 200);
    assert.strictEqual(unyankRes.body.yanked, false);

    const latestRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@trustedowner/semver-pkg/versions/latest",
    );
    assert.strictEqual(latestRes.status, 200);
    assert.strictEqual(latestRes.body.version, "2.0.0");

    const listRes = await request(env.app, "GET", "/v0/extensions");
    assert.strictEqual(listRes.status, 200);
    const ext = listRes.body.extensions.find(
      (e) => e.id === "semver-pkg" && e.namespace === "trustedowner",
    );
    assert.ok(ext);
    assert.strictEqual(ext.latestVersion, "2.0.0");
  });
});

describe("Extensions - publish flow", () => {
  let env, untrustedToken, adminToken;

  before(async () => {
    env = await createTestEnv();
    // First signup is auto-admin
    const adminRes = await signup(env.app, "adminuser", "password123");
    adminToken = adminRes.body.token;

    // Second user is normal (not trusted)
    const userRes = await signup(env.app, "regularuser", "password123");
    untrustedToken = userRes.body.token;
  });

  after(() => env.cleanup());

  it("untrusted user publish goes to pending", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world/versions",
      {
        body: SAMPLE_SOURCE,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, "pending");
  });

  it("rejects duplicate version", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world/versions",
      {
        body: SAMPLE_SOURCE,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 409);
  });

  it("rejects publish with manifest id mismatch", async () => {
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/different-id/versions",
      {
        body: SAMPLE_SOURCE,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.message.includes("does not match"));
  });

  it("enforces one-pending-per-owner", async () => {
    const source2 = `var Fluorite = { manifest: { id: 'hello-world', name: 'Hello', version: '2.0.0', license: 'MIT', description: 'd' } };`;
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world/versions",
      {
        body: source2,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "VERSION_PENDING_REVIEW");
  });

  it("gets extension info with status=all shows pending version", async () => {
    const res = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/hello-world?status=all",
      { headers: authHeaders(untrustedToken) },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, "hello-world");
    assert.ok(res.body.versions.length >= 1);
    assert.strictEqual(res.body.versions[0].status, "pending");
  });

  it("returns 404 for unknown extension", async () => {
    const res = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/nonexistent",
    );
    assert.strictEqual(res.status, 404);
  });

  it("admin approves pending version, flips owner to trusted", async () => {
    const approveRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/hello-world/versions/1.0.0",
      {
        body: JSON.stringify({ status: "approved" }),
        headers: {
          ...authHeaders(adminToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(approveRes.status, 200);
    assert.strictEqual(approveRes.body.status, "published");

    const userRes = await request(env.app, "GET", "/v0/users/regularuser");
    assert.strictEqual(userRes.status, 200);
    assert.strictEqual(userRes.body.trusted, true);
  });

  it("gets extension info after approval", async () => {
    const res = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/hello-world",
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, "hello-world");
  });

  it("next publish auto-publishes for trusted user", async () => {
    const source2 = `var Fluorite = { manifest: { id: 'hello-world', name: 'Hello', version: '2.0.0', license: 'MIT', description: 'd' } };`;
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world/versions",
      {
        body: source2,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.status, "published");
  });

  it("rejects publishing a version lower than the published one", async () => {
    const source = `var Fluorite = { manifest: { id: 'hello-world', name: 'Hello', version: '1.5.0', license: 'MIT', description: 'd' } };`;
    const res = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world/versions",
      {
        body: source,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "VERSION_TOO_LOW");
  });

  it("fetches compiled code with application/javascript Accept", async () => {
    const res = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/hello-world/versions/1.0.0",
      { headers: { Accept: "application/javascript" } },
    );
    assert.strictEqual(res.status, 200);
    assert.ok(typeof res.body === "string");
  });

  it("yanked published version can still be fetched directly (not 404)", async () => {
    const source = `var Fluorite = { manifest: { id: 'yanked-fetch', name: 'Yanked Fetch', version: '1.0.0', license: 'MIT', description: 'd' } };`;
    const pubRes = await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/yanked-fetch/versions",
      {
        body: source,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );
    assert.strictEqual(pubRes.status, 201);
    assert.strictEqual(pubRes.body.status, "published");

    const yankRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/yanked-fetch/versions/1.0.0/yank",
      {
        body: JSON.stringify({ yanked: true }),
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(yankRes.status, 200);
    assert.strictEqual(yankRes.body.yanked, true);

    const jsRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/yanked-fetch/versions/1.0.0",
      { headers: { Accept: "application/javascript" } },
    );
    assert.strictEqual(jsRes.status, 200);
    assert.ok(typeof jsRes.body === "string");
    assert.ok(jsRes.body.includes("yanked-fetch"));

    const metaRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/yanked-fetch/versions/1.0.0",
    );
    assert.strictEqual(metaRes.status, 200);
    assert.strictEqual(metaRes.body.yanked, true);
  });

  it("yank and un-yank", async () => {
    const yankRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/hello-world/versions/1.0.0/yank",
      {
        body: JSON.stringify({ yanked: true, reason: "Bug found" }),
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(yankRes.status, 200);
    assert.strictEqual(yankRes.body.yanked, true);

    const unyankRes = await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/hello-world/versions/1.0.0/yank",
      {
        body: JSON.stringify({ yanked: false }),
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(unyankRes.status, 200);
    assert.strictEqual(unyankRes.body.yanked, false);
  });

  it("yanked versions hidden from default view", async () => {
    const source3 = `var Fluorite = { manifest: { id: 'hello-world-yanked', name: 'Yanked Test', version: '1.0.0', license: 'MIT', description: 'd' } };`;
    await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/hello-world-yanked/versions",
      {
        body: source3,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );

    await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/hello-world-yanked/versions/1.0.0/yank",
      {
        body: JSON.stringify({ yanked: true }),
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/json",
        },
      },
    );

    const defaultRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/hello-world-yanked",
    );
    assert.strictEqual(defaultRes.status, 404);

    const allRes = await request(
      env.app,
      "GET",
      "/v0/extensions/@regularuser/hello-world-yanked?status=all",
      { headers: authHeaders(untrustedToken) },
    );
    assert.strictEqual(allRes.status, 200);
    assert.strictEqual(allRes.body.versions.length, 1);
    assert.strictEqual(allRes.body.versions[0].yanked, true);
  });

  it("delete version", async () => {
    const res = await request(
      env.app,
      "DELETE",
      "/v0/extensions/@regularuser/hello-world/versions/1.0.0",
      { headers: authHeaders(untrustedToken) },
    );
    assert.strictEqual(res.status, 204);
  });

  it("delete extension", async () => {
    const res = await request(
      env.app,
      "DELETE",
      "/v0/extensions/@regularuser/hello-world",
      { headers: authHeaders(untrustedToken) },
    );
    assert.strictEqual(res.status, 204);
  });

  it("trust restored on approval even with existing published versions", async () => {
    await request(env.app, "PATCH", "/v0/users/regularuser/trust", {
      body: JSON.stringify({ trusted: false }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });

    const checkBefore = await request(env.app, "GET", "/v0/users/regularuser");
    assert.strictEqual(checkBefore.body.trusted, false);

    const src1 = `var Fluorite = { manifest: { id: 'trust-test', name: 'Trust Test', version: '1.0.0', license: 'MIT', description: 'd' } };`;
    await request(
      env.app,
      "POST",
      "/v0/extensions/@regularuser/trust-test/versions",
      {
        body: src1,
        headers: {
          ...authHeaders(untrustedToken),
          "Content-Type": "application/javascript",
        },
      },
    );

    await request(
      env.app,
      "PATCH",
      "/v0/extensions/@regularuser/trust-test/versions/1.0.0",
      {
        body: JSON.stringify({ status: "approved" }),
        headers: {
          ...authHeaders(adminToken),
          "Content-Type": "application/json",
        },
      },
    );

    const checkAfter = await request(env.app, "GET", "/v0/users/regularuser");
    assert.strictEqual(checkAfter.body.trusted, true);
  });
});

describe("Stats", () => {
  let env, owner1Token, owner2Token;

  before(async () => {
    env = await createTestEnv(
      {},
      { publishing: { firstPublishRequiresReview: false } },
    );
    const adminRes = await signup(env.app, "statsadmin", "password123");
    owner1Token = adminRes.body.token;
    const user2Res = await signup(env.app, "owner2", "password123");
    owner2Token = user2Res.body.token;
  });

  after(() => env.cleanup());

  it("counts distinct owners and packages, not raw version rows", async () => {
    const src1a = `var Fluorite = { manifest: { id: 'pkg-a', name: 'Pkg A', version: '1.0.0', license: 'MIT', description: 'd' } };`;
    const src1b = `var Fluorite = { manifest: { id: 'pkg-a', name: 'Pkg A', version: '2.0.0', license: 'MIT', description: 'd' } };`;
    const src2 = `var Fluorite = { manifest: { id: 'pkg-b', name: 'Pkg B', version: '1.0.0', license: 'MIT', description: 'd' } };`;

    await request(
      env.app,
      "POST",
      "/v0/extensions/@statsadmin/pkg-a/versions",
      {
        body: src1a,
        headers: {
          ...authHeaders(owner1Token),
          "Content-Type": "application/javascript",
        },
      },
    );
    await request(
      env.app,
      "POST",
      "/v0/extensions/@statsadmin/pkg-a/versions",
      {
        body: src1b,
        headers: {
          ...authHeaders(owner1Token),
          "Content-Type": "application/javascript",
        },
      },
    );
    await request(env.app, "POST", "/v0/extensions/@owner2/pkg-b/versions", {
      body: src2,
      headers: {
        ...authHeaders(owner2Token),
        "Content-Type": "application/javascript",
      },
    });

    const res = await request(env.app, "GET", "/v0/stats");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.published, 2);
    assert.strictEqual(res.body.authors, 2);
  });
});

describe("Interrupted publish recovery", () => {
  let env;

  before(async () => {
    env = await createTestEnv();
    await signup(env.app, "recoveruser", "password123");
    await signup(env.app, "recoveruser2", "password123");
  });

  after(() => env.cleanup());

  async function insertStagingRow(namespace, packageId, version) {
    const user = await getStmt("getUserByNamespace").get(namespace);
    const path = blobPath(
      env.deployment.storage.dataDir,
      namespace,
      packageId,
      version,
    );
    await getStmt("createVersion").run(
      user.id,
      packageId,
      version,
      "staging",
      JSON.stringify({
        id: packageId,
        name: "Interrupted",
        version,
        license: "MIT",
        description: "d",
      }),
      path,
      new Date().toISOString(),
      null,
    );
    return path;
  }

  it("promotes a staging version whose artifact exists after a crash between rename and finalize", async () => {
    const path = await insertStagingRow(
      "recoveruser",
      "interrupted-ext",
      "1.0.0",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SAMPLE_SOURCE, "utf8");

    await reconcileStaging(env.db, env.deployment.storage.dataDir);

    const v = await getStmt("getVersion").get(
      "recoveruser",
      "interrupted-ext",
      "1.0.0",
    );
    assert.ok(v, "staging row must be recovered, not deleted");
    assert.strictEqual(v.status, "pending");
    assert.strictEqual(v.blob_path, path);
    assert.ok(existsSync(path), "renamed artifact must not be orphaned");
  });

  it("deletes a staging version with no artifact after a crash before the rename", async () => {
    await insertStagingRow("recoveruser2", "interrupted-ext", "1.0.0");

    await reconcileStaging(env.db, env.deployment.storage.dataDir);

    const v = await getStmt("getVersion").get(
      "recoveruser2",
      "interrupted-ext",
      "1.0.0",
    );
    assert.strictEqual(v, undefined, "orphaned staging row must be deleted");
  });
});
