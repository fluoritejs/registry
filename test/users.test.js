import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";

describe("Users", () => {
  let env, adminToken;

  before(async () => {
    env = createTestEnv();
    const res = await signup(env.app, "admin", "password123");
    adminToken = res.body.token;
  });

  after(() => env.cleanup());

  it("lists users", async () => {
    const res = await request(env.app, "GET", "/v0/users");
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.users));
    assert.ok(res.body.users.length >= 1);
  });

  it("gets a user by namespace", async () => {
    const res = await request(env.app, "GET", "/v0/users/admin");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.namespace, "admin");
  });

  it("returns 404 for unknown user", async () => {
    const res = await request(env.app, "GET", "/v0/users/nobody");
    assert.strictEqual(res.status, 404);
  });

  it("admin can create a user directly", async () => {
    const res = await request(env.app, "POST", "/v0/users", {
      body: JSON.stringify({ namespace: "created", password: "password123" }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.namespace, "created");
  });

  it("non-admin cannot create a user", async () => {
    const userRes = await signup(env.app, "regular", "password123");
    const res = await request(env.app, "POST", "/v0/users", {
      body: JSON.stringify({ namespace: "nope", password: "password123" }),
      headers: {
        ...authHeaders(userRes.body.token),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 403);
  });

  it("admin can update user role", async () => {
    const res = await request(env.app, "PATCH", "/v0/users/admin/role", {
      body: JSON.stringify({ type: "admin" }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.type, "admin");
  });

  it("admin can update user trust", async () => {
    const res = await request(env.app, "PATCH", "/v0/users/admin/trust", {
      body: JSON.stringify({ trusted: true }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.trusted, true);
  });

  it("user can delete own account", async () => {
    const signupRes = await signup(env.app, "deleteme", "password123");
    const res = await request(env.app, "DELETE", "/v0/users/deleteme", {
      headers: authHeaders(signupRes.body.token),
    });
    assert.strictEqual(res.status, 204);

    const check = await request(env.app, "GET", "/v0/users/deleteme");
    assert.strictEqual(check.status, 404);
  });
});
