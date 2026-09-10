import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createTestEnv, request, signup, authHeaders } from "./helpers.js";
import { getStmt } from "../src/db.js";

describe("Notifications", () => {
  let env, userToken, adminToken, notifId;

  before(async () => {
    env = createTestEnv();
    const userRes = await signup(env.app, "notifuser", "password123");
    userToken = userRes.body.token;
    const adminRes = await signup(env.app, "notifadmin", "password123");
    adminToken = adminRes.body.token;

    // Create a notification for the user
    const notif = getStmt("createNotification").get(
      getStmt("getUserByNamespace").get("notifuser").id,
      "Your extension has been approved.",
      "test-ext",
      "1.0.0",
      null,
      new Date().toISOString(),
    );
    notifId = notif.id;
  });

  after(() => env.cleanup());

  it("lists notifications", async () => {
    const res = await request(env.app, "GET", "/v0/notifications", {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body.notifications));
    assert.ok(res.body.notifications.length >= 1);
  });

  it("marks notification as read", async () => {
    const listRes = await request(env.app, "GET", "/v0/notifications", {
      headers: authHeaders(userToken),
    });
    const nId = listRes.body.notifications[0].id;
    const res = await request(env.app, "PATCH", `/v0/notifications/${nId}`, {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.readAt);
  });

  it("returns 404 for notification belonging to another user", async () => {
    const res = await request(env.app, "PATCH", `/v0/notifications/${notifId}`, {
      headers: authHeaders(adminToken),
    });
    assert.strictEqual(res.status, 404);
  });

  it("deletes a single notification", async () => {
    // Create another notification
    getStmt("createNotification").run(
      getStmt("getUserByNamespace").get("notifuser").id,
      "Test notification",
      "test-ext",
      "1.0.0",
      null,
      new Date().toISOString(),
    );
    const listRes = await request(env.app, "GET", "/v0/notifications", {
      headers: authHeaders(userToken),
    });
    const nId = listRes.body.notifications[0].id;
    const res = await request(env.app, "DELETE", `/v0/notifications/${nId}`, {
      headers: authHeaders(userToken),
    });
    assert.strictEqual(res.status, 204);
  });

  it("bulk-deletes read notifications", async () => {
    const res = await request(
      env.app,
      "DELETE",
      "/v0/notifications?status=read",
      { headers: authHeaders(userToken) },
    );
    assert.strictEqual(res.status, 204);
  });

  it("returns unread count header", async () => {
    const res = await request(env.app, "GET", "/v0/notifications", {
      headers: authHeaders(userToken),
    });
    assert.ok(res.headers["x-unread-notifications"] !== undefined);
  });
});
