# API Reference

All endpoints are under `/v0/`. Responses use `Content-Type: application/json` unless otherwise noted.

## Authentication

Most endpoints require a `Bearer` token in the `Authorization` header. Tokens come from two sources:

- **Session tokens**: returned by `POST /v0/auth/signup` and `POST /v0/auth/login`. Expire after `auth.tokenTtl` (default 7 days).
- **Automation tokens**: created via `POST /v0/auth/tokens`. Have explicit scopes (currently only `publish`). Never expire unless revoked. Track `lastUsedAt` on each use.

Changing a user's password revokes all session tokens and automation tokens for that user.

### Common Response Headers

| Header                   | When                                            | Description                                                                                                               |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `X-Unread-Notifications` | Auth-required responses, notification endpoints | Count of unread notifications for the authenticated user. Omitted when `notifications.includeUnreadCountHeader` is false. |

---

## Auth — `/v0/auth`

### POST /v0/auth/signup

Create a new account. Rate-limited by IP.

**Public.** No token required.

**Body:**

```json
{ "namespace": "myname", "password": "atleast8chars", "displayName": "My Name" }
```

`displayName` is optional.

**Response 201:**

```json
{
  "user": {
    "namespace": "myname",
    "displayName": "My Name",
    "type": "admin",
    "trusted": true,
    "tosAcceptedAt": "",
    "tosVersion": "",
    "privacyAcceptedAt": "",
    "privacyVersion": ""
  },
  "token": "abc123..."
}
```

`type` is `"admin"` and `trusted` is `true` when this is the first user and `firstUserBecomesAdmin` is enabled. The four terms fields record which Terms of Service / Privacy Policy versions this user has accepted and when. When terms enforcement is enabled, a first (admin) user is auto-accepted.

**Errors:** 400 (`VALIDATION_ERROR`), 409 (`NAMESPACE_TAKEN`), 429 (`RATE_LIMITED`)

---

### POST /v0/auth/login

**Public.** No token required.

**Body:**

```json
{ "namespace": "myname", "password": "atleast8chars" }
```

**Response 200:** Same shape as signup.

**Errors:** 401 (`UNAUTHORIZED`), 429 (`RATE_LIMITED`)

---

### POST /v0/auth/logout

Invalidates the current session token. **Requires auth.**

**Response 204** (empty body)

---

### GET /v0/auth/me

Show the current authenticated user. **Requires auth.**

**Response 200:**

```json
{
  "namespace": "myname",
  "displayName": "My Name",
  "type": "admin",
  "trusted": true
}
```

---

### GET /v0/auth/sessions

List active (non-expired) session tokens. **Requires auth.**

**Response 200:**

```json
[
  {
    "id": "token_hash_sha256",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "expiresAt": "2026-01-08T00:00:00.000Z"
  }
]
```

---

### DELETE /v0/auth/sessions

Revoke all session tokens. **Requires auth.**

**Response 204**

---

### DELETE /v0/auth/sessions/:id

Revoke a specific session by its token hash (the `id` field from the sessions list). **Requires auth.**

**Response 204** or 404.

---

### GET /v0/auth/tokens

List automation tokens. **Requires auth.**

**Response 200:**

```json
[
  {
    "id": "uuid",
    "name": "CI Publisher",
    "scopes": ["publish"],
    "createdAt": "2026-01-01T00:00:00.000Z",
    "lastUsedAt": "2026-01-05T12:00:00.000Z"
  }
]
```

---

### POST /v0/auth/tokens

Create an automation token. **Requires auth.** The token value is returned only in the creation response — store it securely.

**Body:**

```json
{ "name": "CI Publisher", "scopes": ["publish"] }
```

**Response 201:**

```json
{
  "id": "uuid",
  "name": "CI Publisher",
  "scopes": ["publish"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "lastUsedAt": null,
  "token": "abc123..."
}
```

**Errors:** 400 (`VALIDATION_ERROR` for missing/invalid fields or scopes)

---

### DELETE /v0/auth/tokens/:id

Revoke an automation token by ID. **Requires auth.**

**Response 204** or 404.

---

## Users — `/v0/users`

Public endpoints use optional auth (pass a token to see your own elevated view where applicable).

### GET /v0/users

List users, paginated.

**Query params:** `limit`, `cursor`

**Response 200:**

```json
{
  "users": [
    {
      "namespace": "admin",
      "displayName": "Administrator",
      "type": "admin",
      "trusted": true
    }
  ],
  "nextCursor": "base64..."
}
```

---

### POST /v0/users

Admin-only. Create a user directly. `password` must be a string of at least 8 characters.

**Body:**

```json
{
  "namespace": "newuser",
  "password": "atleast8chars",
  "displayName": "New User"
}
```

**Response 201:** User object. Created user is `type: normal`, `trusted: false`.

**Errors:** 400, 403, 409

---

### GET /v0/users/:namespace

**Response 200:** User object.

**Errors:** 404

---

### PATCH /v0/users/:namespace

Update display name or password. Owners can update their own profile. Admins can update anyone.

**Body:**

```json
{ "displayName": "New Name", "password": "newpassword123" }
```

Both fields are optional. Changing the password revokes all sessions and automation tokens.

**Response 200:** Updated user object.

---

### DELETE /v0/users/:namespace

Delete a user and revoke all their tokens. Owners can delete themselves. Admins can delete anyone.

**Response 204**

---

### PATCH /v0/users/:namespace/role

Admin-only. Set a user's role.

**Body:**

```json
{ "type": "normal" }
```

Valid values: `"admin"`, `"normal"`.

**Response 200:** Updated user object.

---

### PATCH /v0/users/:namespace/trust

Admin-only. Toggle a user's trusted status.

**Body:**

```json
{ "trusted": true }
```

**Response 200:** Updated user object.

---

## Extensions — `/v0/extensions`

Public endpoints with optional auth.

### GET /v0/extensions

List published extensions, optionally filtered by search query.

**Query params:** `q`, `limit`, `cursor`

**Response 200:**

```json
{
  "extensions": [
    {
      "namespace": "myname",
      "id": "hello-world",
      "name": "Hello World",
      "description": "A simple extension",
      "license": "MIT",
      "latestVersion": "1.2.0",
      "publishedAt": "2026-01-05T12:00:00.000Z",
      "totalDownloads": 42
    }
  ],
  "nextCursor": "base64..."
}
```

Search (`q`) matches against namespace, package ID, name, and description.

---

### GET /v0/extensions/:namespace/:id

Get extension details and its published versions.

**Query params:** `status` (optional)

- Default (no `status` param): returns only `published`, non-yanked versions. Returns 404 if no published versions exist.
- `status=all`: returns all versions regardless of status. Requires the authenticated user to be the owner or an admin.

**Response 200:**

```json
{
  "namespace": "myname",
  "id": "hello-world",
  "versions": [
    {
      "version": "1.2.0",
      "status": "published",
      "createdAt": "2026-01-05T12:00:00.000Z",
      "publishedAt": "2026-01-05T12:00:00.000Z",
      "yanked": false,
      "yankReason": null,
      "downloads": 42,
      "id": "hello-world",
      "name": "Hello World",
      "license": "MIT",
      "description": "A simple extension"
    }
  ]
}
```

**Errors:** 403 (`FORBIDDEN` for `status=all` by non-owner/non-admin), 404

---

### POST /v0/extensions/:namespace/:id/versions

Publish a new version. **Requires auth + `publish` scope.**

The request body is the raw JavaScript source, sent with `Content-Type: application/javascript`. The server parses it to extract the Fluorite manifest — it does not execute the code.

**Headers:**

```
Authorization: Bearer <token>
Content-Type: application/javascript
```

**Body:** Raw `.js` source (max 1 MB).

**Behavior:**

- The manifest `id` field in the source must match the `:id` URL parameter.
- Duplicate versions (same namespace + id + version) are rejected with 409.
- If `onePendingPerOwner` is enabled and you already have a pending version, you get 403.
- With `publishing.firstPublishRequiresReview: true` (the default), untrusted users' first publish goes to `pending` until an admin approves it, after which they're trusted. If the option is disabled, untrusted publishes go straight to `published`.

**Response 201:**

```json
{
  "version": "1.0.0",
  "status": "published",
  "createdAt": "2026-01-05T12:00:00.000Z",
  "publishedAt": "2026-01-05T12:00:00.000Z",
  "yanked": false,
  "yankReason": null,
  "downloads": 0,
  "id": "hello-world",
  "name": "Hello World",
  "license": "MIT",
  "description": "A simple extension"
}
```

When `status` is `"pending"`, `publishedAt` is `null`.

**Errors:** 400 (`INVALID_MANIFEST`, `MANIFEST_MISMATCH`), 403 (`FORBIDDEN`, `VERSION_PENDING_REVIEW`), 404, 409 (`VERSION_EXISTS`)

---

### GET /v0/extensions/:namespace/:id/versions/:version

Fetch version details or compiled source code.

Set `Accept: application/javascript` to get the raw compiled JS. Any other Accept value (or omitted) returns JSON metadata.

**When `Accept: application/javascript`:**

The compiled source is returned with `Content-Type: application/javascript`. Download count is incremented.

**Response 200 (JS):**

```
var Fluorite = { ... }
```

**Response 200 (JSON):**

```json
{
  "version": "1.0.0",
  "status": "published",
  ...
}
```

Use `:version=latest` to resolve the most recent published, non-yanked version.

Unpublished and yanked versions are only visible to the extension owner and admins; anyone else gets 404.

**Errors:** 404 (`NOT_FOUND`, `BLOB_MISSING`)

---

### PATCH /v0/extensions/:namespace/:id/versions/:version

Admin-only. Approve or reject a pending version.

**Body:**

```json
{ "status": "approved", "reason": "optional explanation" }
```

`status` must be `"approved"` or `"rejected"`.

Approving a version also grants the owner `trusted: true` if this is their first approved version.

**Response 200:** Updated version object.

**Errors:** 400 (`VALIDATION_ERROR`, `INVALID_STATUS`), 404

---

### DELETE /v0/extensions/:namespace/:id/versions/:version

Delete a specific version and its blob file. Owner or admin.

**Response 204**

---

### PATCH /v0/extensions/:namespace/:id/versions/:version/yank

Yank or un-yank a version. Owner or admin. Yanked versions are excluded from public listings and `latest` resolution. The blob file is preserved.

**Body:**

```json
{ "yanked": true, "reason": "Security vulnerability" }
```

`yanked` must be a boolean. `reason` is optional.

**Response 200:** Updated version object.

**Errors:** 400, 403, 404

---

### DELETE /v0/extensions/:namespace/:id

Delete an extension and all its versions. Owner or admin.

**Response 204**

---

## Moderation Worklist — `/v0/versions`

Admin-only.

### GET /v0/versions

List versions filtered by status. Requires `status` query param.

**Query params:** `status` (required), `limit`, `cursor`

**Response 200:**

```json
{
  "versions": [
    {
      "version": "1.0.0",
      "status": "pending",
      "namespace": "myname",
      "extensionId": "hello-world",
      "id": "hello-world",
      "name": "Hello World",
      ...
    }
  ],
  "nextCursor": "base64..."
}
```

---

## Webhooks — `/v0/webhooks`

Admin-only. Webhooks fire on version lifecycle events.

### GET /v0/webhooks

List all webhooks.

**Response 200:**

```json
[
  {
    "id": "uuid",
    "url": "https://example.com/hook",
    "events": ["version.published", "version.approved"],
    "enabled": true,
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
]
```

Note: the `secret` is not returned on list or update — only on creation.

---

### POST /v0/webhooks

Create a webhook. The `secret` is returned once and must be stored.

**Body:**

```json
{
  "url": "https://example.com/hook",
  "events": ["version.published", "version.pending"]
}
```

**Valid events:** `version.published`, `version.pending`, `version.approved`, `version.rejected`, `version.yanked`

**Response 201:**

```json
{
  "id": "uuid",
  "url": "https://example.com/hook",
  "events": ["version.published", "version.pending"],
  "enabled": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "secret": "hex_string"
}
```

---

### PATCH /v0/webhooks/:id

Update a webhook's URL, events, or enabled state.

**Body:** All fields optional.

```json
{
  "url": "https://new-url.com/hook",
  "events": ["version.published"],
  "enabled": false
}
```

**Response 200:** Updated webhook (without secret).

---

### DELETE /v0/webhooks/:id

**Response 204** or 404.

---

### Webhook Payload Format

```json
{
  "event": "version.published",
  "extension": { "namespace": "myname", "id": "hello-world" },
  "version": { "version": "1.0.0", "status": "published" },
  "timestamp": "2026-01-05T12:00:00.000Z"
}
```

### Verifying Webhook Signatures

Each delivery includes an `X-Fluorite-Signature` header:

```
X-Fluorite-Signature: sha256=<hex-digest>
```

Compute HMAC-SHA256 of the raw request body using the webhook's secret (the hex string returned on creation) as the key. Compare it to the value in the header.

```js
import crypto from "node:crypto";

function verifySignature(body, secret, signature) {
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", Buffer.from(secret, "hex"))
      .update(body)
      .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
```

Failed deliveries are retried up to `webhooks.maxRetries` times with linear backoff (`retryBackoffMs * attempt`). Delivery timeout is `webhooks.deliveryTimeoutMs`.

---

## Notifications — `/v0/notifications`

Requires auth.

### GET /v0/notifications

List notifications for the authenticated user.

**Query params:** `status` (`"read"` or `"unread"`), `limit`, `cursor`

**Response 200:**

```json
{
  "notifications": [
    {
      "id": "1",
      "message": "Your version 1.0.0 of hello-world has been approved.",
      "packageId": "hello-world",
      "version": "1.0.0",
      "readAt": null,
      "createdAt": "2026-01-05T12:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

---

### PATCH /v0/notifications/:id

Mark a notification as read.

**Response 200:** Updated notification object.

---

### DELETE /v0/notifications/:id

Delete a single notification.

**Response 204**

---

### DELETE /v0/notifications?status=read

Bulk-delete all read notifications. The `status=read` query param is required.

**Response 204**

---

## Stats — `/v0/stats`

### GET /v0/stats

Public. Returns aggregate registry statistics.

**Response 200:**

```json
{ "published": 42, "pending": 3, "authors": 15, "totalDownloads": 1234 }
```

---

## Legal — `/v0/terms`, `/v0/privacy`

Terms of Service and Privacy Policy documents are stored as markdown files on disk (see `terms.dir` in configuration). Each document has a version string; when a version changes, users must re-accept before using authenticated features. Enforcement is optional and controlled by `terms.enforce`.

When enforcement is enabled (`terms.enforce: true`) and the user has not accepted the current versions, authenticated endpoints return:

```json
{
  "error": {
    "code": "TERMS_ACCEPTANCE_REQUIRED",
    "message": "You must accept the current terms of service and privacy policy.",
    "field": null
  }
}
```

Automation tokens are exempt from terms enforcement; compliance is the responsibility of the token owner.

### GET /v0/terms

Public. Returns the Terms of Service as raw markdown.

**Response 200:** `Content-Type: text/markdown`, `X-Terms-Version` header carries the current version.

**Response 404:** `TERMS_NOT_FOUND` if no terms have been published.

### GET /v0/privacy

Public. Returns the Privacy Policy as raw markdown. Same headers and error behavior as `GET /v0/terms`.

### POST /v0/terms/accept

Requires a session token. Records acceptance of the current terms and privacy versions.

**Body:**

```json
{ "tosVersion": "2026-09-01", "privacyVersion": "2026-09-01" }
```

Both versions must match the current versions from the manifest. Automation tokens are rejected (`FORBIDDEN`).

**Response 200:**

```json
{ "success": true }
```

**Response 400:** `INVALID_TERMS_VERSION` when a supplied version does not match the current one.

### PATCH /v0/admin/terms

Requires admin. Replaces the Terms of Service content and sets a new version. The body is raw markdown; pass the version as a query parameter.

```
PATCH /v0/admin/terms?version=2026-09-01
Content-Type: text/markdown

# Terms of Service
...
```

**Response 200:**

```json
{ "version": "2026-09-01", "path": "/data/terms/tos.md" }
```

**Response 400:** `VALIDATION_ERROR` when `version` is missing or the body is empty.

### PATCH /v0/admin/privacy

Requires admin. Same behavior as `PATCH /v0/admin/terms`, for the Privacy Policy.

---

## Pagination

List endpoints use cursor-based pagination. Pass `limit` and `cursor` as query params. The response includes `nextCursor` (base64-encoded) when more pages exist. Pass it as the `cursor` param on the next request.

Default page sizes come from `config.yaml` under `listings`. Maximum is `maxPageSize` (default 50).

## Error Format

All errors follow this shape:

```json
{
  "error": { "code": "NOT_FOUND", "message": "User not found.", "field": null }
}
```

`field` is a string when the error relates to a specific request field, `null` otherwise.

| HTTP Status | Code                        | Meaning                                  |
| ----------- | --------------------------- | ---------------------------------------- |
| 400         | `VALIDATION_ERROR`          | Bad request body or params               |
| 400         | `INVALID_MANIFEST`          | Source has no valid Fluorite manifest    |
| 400         | `MANIFEST_MISMATCH`         | Manifest ID doesn't match URL            |
| 400         | `INVALID_TERMS_VERSION`     | Supplied version doesn't match current   |
| 401         | `UNAUTHORIZED`              | Missing or invalid token                 |
| 401         | `TOKEN_EXPIRED`             | Session token has expired                |
| 403         | `FORBIDDEN`                 | Insufficient permissions                 |
| 403         | `TERMS_ACCEPTANCE_REQUIRED` | Terms not accepted                       |
| 403         | `VERSION_PENDING_REVIEW`    | Already have a pending version           |
| 404         | `NOT_FOUND`                 | Resource doesn't exist                   |
| 404         | `BLOB_MISSING`              | Version exists but compiled file is gone |
| 404         | `TERMS_NOT_FOUND`           | Terms/privacy document not published     |
| 409         | `VERSION_EXISTS`            | That version number already exists       |
| 409         | `NAMESPACE_TAKEN`           | Namespace is already registered          |
| 429         | `RATE_LIMITED`              | Too many requests                        |
| 500         | `INTERNAL_ERROR`            | Server-side failure                      |
