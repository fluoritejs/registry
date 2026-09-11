import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";
import {
  encryptSecret,
  decryptSecret,
  deliverWithRetry,
  signatureHeader,
} from "../src/webhooks.js";
import { loadConfig } from "../src/config.js";

describe("Webhooks — encryption key config", () => {
  it("accepts a valid 32-byte hex encryption key at config load", () => {
    const key = "a".repeat(64);
    const cfg = loadConfig({ webhooks: { encryptionKey: key } });
    assert.strictEqual(cfg.webhooks.encryptionKey, key);
  });

  it("rejects a malformed encryption key at config load", () => {
    const badKeys = ["tooshort", "x".repeat(64), "zz".repeat(32), 12345];
    for (const bad of badKeys) {
      assert.throws(
        () => loadConfig({ webhooks: { encryptionKey: bad } }),
        /encryptionKey/,
      );
    }
  });
});

describe("Webhooks — encryption key required", () => {
  let env, adminToken;

  before(async () => {
    env = createTestEnv();
    const res = await signup(env.app, "keylessadmin", "password123");
    adminToken = res.body.token;
  });

  after(() => env.cleanup());

  it("refuses to create a webhook when webhooks.encryptionKey is not configured", async () => {
    const res = await request(env.app, "POST", "/v0/webhooks", {
      body: JSON.stringify({
        url: "https://example.com/hook",
        events: ["version.published"],
      }),
      headers: {
        ...authHeaders(adminToken),
        "Content-Type": "application/json",
      },
    });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.error.code, "WEBHOOK_ENCRYPTION_REQUIRED");
    assert.ok(res.body.error.message.includes("encryptionKey"));
  });

  it("no webhook was created", async () => {
    const res = await request(env.app, "GET", "/v0/webhooks", {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);
  });

  it("encryptSecret throws when no key is configured", () => {
    assert.throws(() => encryptSecret("a-secret"), /encryptionKey/);
  });
});

describe("Webhooks", () => {
  let env, adminToken, encryptionKey;

  before(async () => {
    encryptionKey = crypto.randomBytes(32).toString("hex");
    env = createTestEnv({}, { webhooks: { encryptionKey } });
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

  it("rejects loopback, IPv6 loopback, and non-https webhook URLs", async () => {
    const create = (url) =>
      request(env.app, "POST", "/v0/webhooks", {
        body: JSON.stringify({ url, events: ["version.published"] }),
        headers: {
          ...authHeaders(adminToken),
          "Content-Type": "application/json",
        },
      });

    for (const url of [
      "http://127.0.0.1/hook",
      "http://[::1]/hook",
      "https://[::1]/hook",
      "https://127.0.0.1/hook",
      "http://localhost:4567/hook",
      "http://10.0.0.5/hook",
      "http://192.168.1.1/hook",
      "http://fe80::1/hook",
      "file:///etc/passwd",
      "ftp://example.com/hook",
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

  it("encryptSecret and decryptSecret round-trip the plaintext", () => {
    const secret = "a-plaintext-webhook-secret";
    const encrypted = encryptSecret(secret, encryptionKey);
    assert.notStrictEqual(encrypted, secret);
    assert.strictEqual(decryptSecret(encrypted), secret);
  });

  it("computes the documented X-Fluorite-Signature HMAC", () => {
    const secret = crypto.randomBytes(32).toString("hex");
    const encryptedSecret = encryptSecret(secret, encryptionKey);
    const plaintext = decryptSecret(encryptedSecret);
    const body = JSON.stringify({ event: "version.published" });
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(body).digest("hex");
    assert.strictEqual(signatureHeader(body, plaintext), expected);
  });

  it("refuses webhook delivery over plain HTTP", async () => {
    const encryptedSecret = encryptSecret(
      crypto.randomBytes(32).toString("hex"),
      encryptionKey,
    );
    await assert.rejects(
      deliverWithRetry(
        { url: "http://example.com/hook", secret: encryptedSecret },
        "{}",
        "version.published",
        { maxRetries: 0, deliveryTimeoutMs: 5000, retryBackoffMs: 0 },
      ),
      /HTTPS/,
    );
  });

  it("refuses webhook delivery to destinations resolving to loopback", async () => {
    const encryptedSecret = encryptSecret(
      crypto.randomBytes(32).toString("hex"),
      encryptionKey,
    );
    await assert.rejects(
      deliverWithRetry(
        { url: "https://localhost/hook", secret: encryptedSecret },
        "{}",
        "version.published",
        { maxRetries: 0, deliveryTimeoutMs: 5000, retryBackoffMs: 0 },
      ),
      /restricted/,
    );
  });
});
