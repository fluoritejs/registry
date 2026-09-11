import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { unlinkSync, mkdirSync } from "node:fs";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";
import { join } from "node:path";

describe("Terms of Service & Privacy Policy", () => {
  let env, adminToken, admin, userToken, user, autoToken;

  before(async () => {
    env = createTestEnv({}, { terms: { enforce: true } });
    const adminRes = await signup(env.app, "termsadmin", "password123");
    adminToken = adminRes.body.token;
    admin = adminRes.body.user;

    const userRes = await signup(env.app, "termsuser", "password123");
    userToken = userRes.body.token;
    user = userRes.body.user;
  });

  after(() => env.cleanup());

  it("auto-accepts current terms for the first (admin) user", () => {
    assert.strictEqual(admin.tosVersion, "test-tos");
    assert.strictEqual(admin.privacyVersion, "test-privacy");
    assert.ok(admin.tosAcceptedAt);
    assert.ok(admin.privacyAcceptedAt);
  });

  it("leaves subsequent users unaccepted", () => {
    assert.strictEqual(user.tosVersion, "");
    assert.strictEqual(user.privacyVersion, "");
  });

  it("allows admins to access auth-required routes immediately", async () => {
    const res = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.status, 200);
  });

  it("blocks unaccepted users from auth-required routes", async () => {
    const res = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "TERMS_ACCEPTANCE_REQUIRED");
  });

  it("accepts terms with the current versions", async () => {
    const res = await request(env.app, "POST", "/v0/terms/accept", {
      body: JSON.stringify({
        tosVersion: "test-tos",
        privacyVersion: "test-privacy",
      }),
      headers: { ...authHeaders(userToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { success: true });
  });

  it("allows access after acceptance", async () => {
    const res = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tosVersion, "test-tos");
    assert.strictEqual(res.body.privacyVersion, "test-privacy");
    assert.ok(res.body.tosAcceptedAt);
    assert.ok(res.body.privacyAcceptedAt);
  });

  it("rejects acceptance with a mismatched version", async () => {
    const res = await request(env.app, "POST", "/v0/terms/accept", {
      body: JSON.stringify({
        tosVersion: "wrong",
        privacyVersion: "test-privacy",
      }),
      headers: { ...authHeaders(userToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "INVALID_TERMS_VERSION");
  });

  it("GET /v0/terms returns markdown and a version header", async () => {
    const res = await request(env.app, "GET", "/v0/terms");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "# Test Terms of Service");
    assert.strictEqual(res.headers["x-terms-version"], "test-tos");
    assert.ok(res.headers["content-type"].includes("text/markdown"));
  });

  it("GET /v0/privacy returns markdown and a version header", async () => {
    const res = await request(env.app, "GET", "/v0/privacy");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, "# Test Privacy Policy");
    assert.strictEqual(res.headers["x-terms-version"], "test-privacy");
    assert.ok(res.headers["content-type"].includes("text/markdown"));
  });

  it("PATCH /v0/admin/terms updates content and version", async () => {
    const newContent = "# New Terms of Service v2";
    const res = await request(env.app, "PATCH", "/v0/admin/terms?version=v2", {
      body: newContent,
      headers: { ...authHeaders(adminToken), "Content-Type": "text/markdown" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.version, "v2");

    const getRes = await request(env.app, "GET", "/v0/terms");
    assert.strictEqual(getRes.body, newContent);
    assert.strictEqual(getRes.headers["x-terms-version"], "v2");
  });

  it("rejects non-admin terms updates", async () => {
    const res = await request(env.app, "PATCH", "/v0/admin/terms?version=v3", {
      body: "# x",
      headers: { ...authHeaders(userToken), "Content-Type": "text/markdown" },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "FORBIDDEN");
  });

  it("rejects an update without a version query parameter", async () => {
    const res = await request(env.app, "PATCH", "/v0/admin/terms", {
      body: "# x",
      headers: { ...authHeaders(adminToken), "Content-Type": "text/markdown" },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
  });

  it("forces re-acceptance when the terms version changes", async () => {
    const blocked = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(blocked.body.error.code, "TERMS_ACCEPTANCE_REQUIRED");

    const accept = await request(env.app, "POST", "/v0/terms/accept", {
      body: JSON.stringify({ tosVersion: "v2", privacyVersion: "test-privacy" }),
      headers: { ...authHeaders(userToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(accept.status, 200);

    const ok = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(ok.status, 200);
  });

  it("PATCH /v0/admin/privacy updates content and version", async () => {
    const newContent = "# New Privacy Policy v2";
    const res = await request(
      env.app,
      "PATCH",
      "/v0/admin/privacy?version=v2",
      {
        body: newContent,
        headers: { ...authHeaders(adminToken), "Content-Type": "text/markdown" },
      },
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.version, "v2");

    const getRes = await request(env.app, "GET", "/v0/privacy");
    assert.strictEqual(getRes.body, newContent);
    assert.strictEqual(getRes.headers["x-terms-version"], "v2");
  });

  it("automation tokens bypass terms enforcement", async () => {
    const reaccept = await request(env.app, "POST", "/v0/terms/accept", {
      body: JSON.stringify({ tosVersion: "v2", privacyVersion: "v2" }),
      headers: { ...authHeaders(userToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(reaccept.status, 200);

    const tokRes = await request(env.app, "POST", "/v0/auth/tokens", {
      body: JSON.stringify({ name: "ci", scopes: ["publish"] }),
      headers: { ...authHeaders(userToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(tokRes.status, 201);
    autoToken = tokRes.body.token;

    await request(env.app, "PATCH", "/v0/admin/terms?version=v3", {
      body: "# x",
      headers: { ...authHeaders(adminToken), "Content-Type": "text/markdown" },
    });

    const sessionBlocked = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(sessionBlocked.status, 403);
    assert.strictEqual(
      sessionBlocked.body.error.code,
      "TERMS_ACCEPTANCE_REQUIRED",
    );

    const withToken = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(autoToken),
    });
    assert.strictEqual(withToken.status, 403);
    assert.strictEqual(withToken.body.error.code, "FORBIDDEN");
  });

  it("rejects automation tokens from accepting terms", async () => {
    const res = await request(env.app, "POST", "/v0/terms/accept", {
      body: JSON.stringify({
        tosVersion: "test-tos",
        privacyVersion: "test-privacy",
      }),
      headers: { ...authHeaders(autoToken), "Content-Type": "application/json" },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.error.code, "FORBIDDEN");
  });
});

describe("Terms — missing files", () => {
  let env;

  before(() => {
    env = createTestEnv({}, { terms: { enforce: true } });
  });

  after(() => env.cleanup());

  it("returns 404 when the terms file is missing", () => {
    unlinkSync(join(env.dataDir, "terms", "tos.md"));
    return request(env.app, "GET", "/v0/terms").then((res) => {
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error.code, "TERMS_NOT_FOUND");
    });
  });
});

describe("Terms — enforcement disabled", () => {
  let env, token;

  before(async () => {
    env = createTestEnv({}, { terms: { enforce: false } });
    const res = await signup(env.app, "noenforce", "password123");
    token = res.body.token;
  });

  after(() => env.cleanup());

  it("does not block unaccepted users when enforce is false", async () => {
    const res = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(token),
    });
    assert.strictEqual(res.status, 200);
  });
});

describe("Terms — missing manifest", () => {
  let env, token;

  before(async () => {
    env = createTestEnv({}, { terms: { enforce: true } });
    mkdirSync(join(env.dataDir, "terms"), { recursive: true });
    unlinkSync(join(env.dataDir, "terms", "manifest.yaml"));
    const res = await signup(env.app, "nomanifest", "password123");
    token = res.body.token;
  });

  after(() => env.cleanup());

  it("does not enforce when no manifest exists", async () => {
    const res = await request(env.app, "GET", "/v0/auth/me", {
      headers: authHeaders(token),
    });
    assert.strictEqual(res.status, 200);
  });
});