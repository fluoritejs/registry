import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";
import { extractManifest } from "../src/manifest.js";
import { loadConfig, setConfig } from "../src/config.js";

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
  const config = loadConfig();
  setConfig(config);

  it("extracts a valid manifest", () => {
    const manifest = extractManifest(
      VALID_SOURCE,
      config.publishing.packageIdPattern,
    );
    assert.strictEqual(manifest.id, "test-ext");
    assert.strictEqual(manifest.name, "Test Extension");
    assert.strictEqual(manifest.version, "2.1.0");
    assert.strictEqual(manifest.license, "Apache-2.0");
  });

  it("extracts a manifest from fluorite-compiler output", () => {
    const manifest = extractManifest(
      COMPILED_SOURCE,
      config.publishing.packageIdPattern,
    );
    assert.strictEqual(manifest.id, "helloworld");
    assert.strictEqual(manifest.name, "It works!");
    assert.strictEqual(manifest.version, "0.1.0");
    assert.strictEqual(manifest.license, "LGPL-2.1");
  });

  it("rejects malformed source without executing side effects", () => {
    let threw = false;
    try {
      extractManifest(MALFORMED_SOURCE, config.publishing.packageIdPattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("No Fluorite manifest"));
    }
    assert.ok(threw, "Should have thrown for malformed source");
  });

  it("rejects invalid version", () => {
    const source = `var Fluorite = { manifest: { id: 'test', name: 'T', version: 'not-semver', license: 'MIT', description: 'd' } };`;
    let threw = false;
    try {
      extractManifest(source, config.publishing.packageIdPattern);
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
      extractManifest(source, config.publishing.packageIdPattern);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes("Invalid extension id"));
    }
    assert.ok(threw);
  });
});

describe("Extensions - trusted publish", () => {
  let env, trustedToken;

  before(async () => {
    env = createTestEnv();
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
});

describe("Extensions - publish flow", () => {
  let env, untrustedToken, adminToken;

  before(async () => {
    env = createTestEnv();
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
});
