import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { hashToken } from "../src/auth.js";
import { getStmt } from "../src/db.js";
import {
  createTestEnv,
  request,
  signup,
  login,
  authHeaders,
} from "./helpers.js";

describe("Auth", () => {
  describe("signup", () => {
    let env;
    before(async () => {
      env = await createTestEnv();
    });
    after(() => env.cleanup());

    it("creates an account and returns a token", async () => {
      const res = await signup(env.app);
      assert.strictEqual(res.status, 201);
      assert.ok(res.body.user);
      assert.strictEqual(res.body.user.namespace, "testuser");
      assert.ok(res.body.token);
    });

    it("rejects duplicate namespace", async () => {
      const res = await signup(env.app);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error.code, "NAMESPACE_TAKEN");
    });

    it("rejects short password", async () => {
      const res = await signup(env.app, "newuser", "short");
      assert.strictEqual(res.status, 400);
    });

    it("includes X-Unread-Notifications header", async () => {
      const res = await signup(env.app, "notifuser", "password123");
      assert.strictEqual(res.headers["x-unread-notifications"], "0");
    });

    it("failed signups do not count toward rate limit", async () => {
      const isolated = await createTestEnv();
      try {
        const first = await signup(isolated.app, "testuser", "password123");
        assert.strictEqual(first.status, 201);
        for (let i = 0; i < 10; i++) {
          await signup(isolated.app, "testuser", "other-password");
        }

        const res = await signup(isolated.app, "newuser", "password123");
        assert.strictEqual(res.status, 201);
      } finally {
        await isolated.cleanup();
      }
    });
  });

  describe("first user becomes admin", () => {
    let env;
    before(async () => {
      env = await createTestEnv();
    });
    after(() => env.cleanup());

    it("first signup gets admin role", async () => {
      const res = await signup(env.app, "firstadmin", "password123");
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.type, "admin");
      assert.strictEqual(res.body.user.trusted, true);
    });

    it("second signup is normal", async () => {
      const res = await signup(env.app, "second", "password123");
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.type, "normal");
    });
  });

  describe("bootstrap account path", () => {
    let env;
    before(async () => {
      env = await createTestEnv({
        admin: {
          firstUserBecomesAdmin: false,
          bootstrapAccount: {
            namespace: "bootadmin",
            password: "bootpass1234",
            displayName: "Boot Admin",
          },
        },
      });
    });
    after(() => env.cleanup());

    it("first signup is not admin", async () => {
      const res = await signup(env.app, "regularuser", "password123");
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.user.type, "normal");
    });

    it("bootstrap admin can log in", async () => {
      const res = await login(env.app, "bootadmin", "bootpass1234");
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.user.type, "admin");
      assert.strictEqual(res.body.user.trusted, true);
    });
  });

  describe("login", () => {
    let env;
    before(async () => {
      env = await createTestEnv();
      await signup(env.app, "logintest", "password123");
    });
    after(() => env.cleanup());

    it("returns a session token", async () => {
      const res = await login(env.app, "logintest", "password123");
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.namespace, "logintest");
    });

    it("rejects wrong password", async () => {
      const res = await login(env.app, "logintest", "wrong");
      assert.strictEqual(res.status, 401);
    });

    it("rejects unknown user", async () => {
      const res = await login(env.app, "nobody", "password123");
      assert.strictEqual(res.status, 401);
    });
  });

  describe("logout", () => {
    let env, token;
    before(async () => {
      env = await createTestEnv();
      const res = await signup(env.app, "logoutuser", "password123");
      token = res.body.token;
    });
    after(() => env.cleanup());

    it("invalidates the session", async () => {
      const res = await request(env.app, "POST", "/v0/auth/logout", {
        headers: authHeaders(token),
      });
      assert.strictEqual(res.status, 204);

      const second = await request(env.app, "GET", "/v0/auth/me", {
        headers: authHeaders(token),
      });
      assert.strictEqual(second.status, 401);
    });
  });

  describe("me", () => {
    let env, token;
    before(async () => {
      env = await createTestEnv();
      const res = await signup(env.app, "meuser", "password123");
      token = res.body.token;
    });
    after(() => env.cleanup());

    it("returns the current user", async () => {
      const res = await request(env.app, "GET", "/v0/auth/me", {
        headers: authHeaders(token),
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.namespace, "meuser");
      assert.strictEqual(res.body.type, "admin");
      assert.strictEqual(res.body.trusted, true);
    });

    it("rejects unauthenticated request", async () => {
      const res = await request(env.app, "GET", "/v0/auth/me");
      assert.strictEqual(res.status, 401);
    });

    it("rejects expired token", async () => {
      const signupRes = await signup(env.app, "expireduser", "password123");
      const expiredToken = signupRes.body.token;
      await env.db.unsafe(
        "UPDATE auth_tokens SET expires_at = $1 WHERE token_hash = $2",
        ["2000-01-01T00:00:00.000Z", hashToken(expiredToken)],
      );
      const res = await request(env.app, "GET", "/v0/auth/me", {
        headers: authHeaders(expiredToken),
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error.code, "TOKEN_EXPIRED");
    });
  });

  describe("sessions", () => {
    let env, token;
    before(async () => {
      env = await createTestEnv();
      const res = await signup(env.app, "sessionuser", "password123");
      token = res.body.token;
    });
    after(() => env.cleanup());

    it("lists active sessions with numeric ids", async () => {
      const res = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(token),
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 1);
      assert.strictEqual(typeof res.body[0].id, "number");
    });

    it("revokes all sessions", async () => {
      const res = await request(env.app, "DELETE", "/v0/auth/sessions", {
        headers: authHeaders(token),
      });
      assert.strictEqual(res.status, 204);

      const check = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(token),
      });
      assert.strictEqual(check.status, 401);
    });

    it("revokes a specific session by numeric id", async () => {
      const first = await login(env.app, "sessionuser", "password123");
      const second = await login(env.app, "sessionuser", "password123");
      const firstToken = first.body.token;
      const secondToken = second.body.token;
      const firstSession = await getStmt("getAuthToken").get(
        hashToken(firstToken),
      );
      const sessionId = firstSession.id;
      const listRes = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(firstToken),
      });
      assert.ok(listRes.body.some((s) => s.id === sessionId));
      const delRes = await request(
        env.app,
        "DELETE",
        `/v0/auth/sessions/${sessionId}`,
        { headers: authHeaders(firstToken) },
      );
      assert.strictEqual(delRes.status, 204);

      const firstCheck = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(firstToken),
      });
      const secondCheck = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(secondToken),
      });
      assert.strictEqual(firstCheck.status, 401);
      assert.strictEqual(secondCheck.status, 200);
      assert.ok(!secondCheck.body.some((s) => s.id === sessionId));
    });
  });

  describe("automation tokens", () => {
    let env, token;
    before(async () => {
      env = await createTestEnv();
      const res = await signup(env.app, "autotoken", "password123");
      token = res.body.token;
    });
    after(() => env.cleanup());

    it("creates an automation token", async () => {
      const res = await request(env.app, "POST", "/v0/auth/tokens", {
        body: JSON.stringify({ name: "CI", scopes: ["publish"] }),
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
      });
      assert.strictEqual(res.status, 201);
      assert.ok(res.body.token);
      assert.strictEqual(res.body.name, "CI");
    });

    it("lists automation tokens", async () => {
      const res = await request(env.app, "GET", "/v0/auth/tokens", {
        headers: authHeaders(token),
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 1);
    });

    it("rejects automation tokens on session-only user routes", async () => {
      const autoRes = await request(env.app, "POST", "/v0/auth/tokens", {
        body: JSON.stringify({ name: "CI", scopes: ["publish"] }),
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
      });
      const autoToken = autoRes.body.token;

      const res = await request(env.app, "PATCH", "/v0/users/autotoken", {
        body: JSON.stringify({ displayName: "Nope" }),
        headers: {
          ...authHeaders(autoToken),
          "Content-Type": "application/json",
        },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error.code, "FORBIDDEN");
    });
  });

  describe("password change revokes tokens", () => {
    let env, sessionToken, autoToken;
    before(async () => {
      env = await createTestEnv();
      const signupRes = await signup(env.app, "revokeuser", "password123");
      sessionToken = signupRes.body.token;

      const tokenRes = await request(env.app, "POST", "/v0/auth/tokens", {
        body: JSON.stringify({ name: "CI", scopes: ["publish"] }),
        headers: {
          ...authHeaders(sessionToken),
          "Content-Type": "application/json",
        },
      });
      autoToken = tokenRes.body.token;
    });
    after(() => env.cleanup());

    it("revokes all tokens when password changes", async () => {
      const res = await request(env.app, "PATCH", "/v0/users/revokeuser", {
        body: JSON.stringify({ password: "newpassword456" }),
        headers: {
          ...authHeaders(sessionToken),
          "Content-Type": "application/json",
        },
      });
      assert.strictEqual(res.status, 200);

      const sessionCheck = await request(env.app, "GET", "/v0/auth/sessions", {
        headers: authHeaders(sessionToken),
      });
      assert.strictEqual(sessionCheck.status, 401);

      const autoCheck = await request(env.app, "GET", "/v0/auth/tokens", {
        headers: authHeaders(autoToken),
      });
      assert.strictEqual(autoCheck.status, 401);
    });
  });
});
