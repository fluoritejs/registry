import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";

describe("Webhooks", () => {
  let env, adminToken;

  before(async () => {
    env = createTestEnv();
    const res = await signup(env.app, "whadmin", "password123");
    adminToken = res.body.token;
  });

  after(() => env.cleanup());

  it("creates a webhook", async () => {
    const res = await request(env.app, "POST", "/v0/webhooks", {
      body: JSON.stringify({
        url: "https://example.com/hook",
        events: ["version.published", "version.pending"],
      }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.id);
    assert.ok(res.body.secret);
    assert.strictEqual(res.body.url, "https://example.com/hook");
  });

  it("lists webhooks", async () => {
    const res = await request(env.app, "GET", "/v0/webhooks", {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
  });

  it("non-admin cannot list webhooks", async () => {
    const userRes = await signup(env.app, "whuser", "password123");
    const res = await request(env.app, "GET", "/v0/webhooks", {
      headers: authHeaders(userRes.body.token),
    });
    assert.strictEqual(res.status, 403);
  });

  it("updates a webhook", async () => {
    const listRes = await request(env.app, "GET", "/v0/webhooks", {
      headers: authHeaders(adminToken),
    });
    const whId = listRes.body[0].id;
    const res = await request(env.app, "PATCH", `/v0/webhooks/${whId}`, {
      body: JSON.stringify({ enabled: false }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.enabled, false);
  });

  it("rejects loopback and non-http webhook URLs", async () => {
    const create = async (url) =>
      request(env.app, "POST", "/v0/webhooks", {
        body: JSON.stringify({
          url,
          events: ["version.published"],
        }),
        headers: {
          ...authHeaders(adminToken),
          "Content-Type": "application/json",
        },
      });

    for (const url of [
      "http://127.0.0.1/hook",
      "http://localhost:4567/hook",
      "http://10.0.0.5/hook",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      const res = await create(url);
      assert.strictEqual(res.status, 400);
    }
  });

  it("rejects invalid events on patch", async () => {
    const createRes = await request(env.app, "POST", "/v0/webhooks", {
      body: JSON.stringify({
        url: "https://example.com/invalid-events",
        events: ["version.published"],
      }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    const res = await request(
      env.app,
      "PATCH",
      `/v0/webhooks/${createRes.body.id}`,
      {
        body: JSON.stringify({ events: ["not.an.event"] }),
        headers: {
          ...authHeaders(adminToken),
          "Content-Type": "application/json",
        },
      },
    );
    assert.strictEqual(res.status, 400);
  });

  it("deletes a webhook", async () => {
    const createRes = await request(env.app, "POST", "/v0/webhooks", {
      body: JSON.stringify({
        url: "https://example.com/del",
        events: ["version.published"],
      }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    const res = await request(
      env.app,
      "DELETE",
      `/v0/webhooks/${createRes.body.id}`,
      { headers: authHeaders(adminToken) },
    );
    assert.strictEqual(res.status, 204);
  });

  it("returns 404 for unknown webhook", async () => {
    const res = await request(env.app, "DELETE", "/v0/webhooks/nonexistent", {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.status, 404);
  });
});
