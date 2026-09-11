# Managing the Registry

## Admin Tasks

### Reviewing Pending Versions

When `publishing.firstPublishRequiresReview: true`, new users' first publish goes to `pending` status. To review:

```bash
# List all pending versions
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/v0/versions?status=pending"
```

Approve a version:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "approved"}' \
  http://localhost:3000/v0/extensions/@username/hello-world/versions/1.0.0
```

Reject with a reason:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "rejected", "reason": "Missing manifest fields"}' \
  http://localhost:3000/v0/extensions/@username/hello-world/versions/1.0.0
```

Approving a user's first version automatically marks them as `trusted`. Their future publishes skip review and go straight to `published`.

### Managing Users

List all users:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3000/v0/users
```

Create a user directly (no signup required):

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"namespace": "collaborator", "password": "securepass123"}' \
  http://localhost:3000/v0/users
```

Promote a user to admin:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "admin"}' \
  http://localhost:3000/v0/users/collaborator/role
```

Grant or revoke trusted status:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trusted": false}' \
  http://localhost:3000/v0/users/collaborator/trust
```

### Yanking a Version

Yanking hides a version from public listings and the `latest` resolution without deleting it. The blob file stays on disk.

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": true, "reason": "Security issue in v2.1.0"}' \
  http://localhost:3000/v0/extensions/@username/hello-world/versions/2.1.0/yank
```

To un-yank:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": false}' \
  http://localhost:3000/v0/extensions/@username/hello-world/versions/2.1.0/yank
```

## Webhooks

### Setting Up

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-service.com/webhook",
    "events": ["version.published", "version.approved", "version.rejected"]
  }' \
  http://localhost:3000/v0/webhooks
```

Store the returned `secret`. You need it to verify incoming webhook payloads.

### Verifying Signatures

Each webhook delivery includes an `X-Fluorite-Signature` header containing `sha256=<hmac-hex>`. To verify:

```js
import crypto from "node:crypto";

function verify(body, secretHex, signatureHeader) {
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", secretHex)
      .update(body)
      .digest("hex");
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
```

Always use `crypto.timingSafeEqual` to prevent timing attacks.

### Delivery Behavior

- Failed deliveries retry up to 3 times (configurable) with linear backoff
- Each attempt times out after 5 seconds (configurable)
- Payload is JSON with `event`, `extension`, `version`, and `timestamp` fields
- Disabled webhooks (`enabled: false`) are skipped

## Monitoring

### Stats

```bash
curl http://localhost:3000/v0/stats
```

Returns published version count, pending count, author count, and total downloads.

### Notifications

Users receive notifications when:

- A version is approved or rejected (sent to the publisher)
- A version is published (first publish triggers a notification)

Check unread count from the `X-Unread-Notifications` header on any authenticated response, or list notifications directly:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v0/notifications?status=unread"
```

### Logs

The server logs to stdout/stderr with timestamps and colored level labels. Set `logging.level` in `config.yaml`:

- `error` — errors only
- `warn` — warnings and errors
- `info` — startup, publish events, moderation actions
- `debug` — request-level logging (method, path, status, duration)

Change the level without restarting:

```bash
kill -SIGHUP <pid>
```

## Backup and Recovery

### Database

The SQLite database lives at `<dataDir>/registry.sqlite`. To back it up:

Stop the server first, then copy the file:

```bash
cp data/registry.sqlite data/registry.sqlite.bak
```

For a live backup while the server runs, use SQLite's backup command instead:

```bash
sqlite3 data/registry.sqlite ".backup data/registry-backup.sqlite"
```

### Blob Files

Extension blobs live under `<dataDir>/blobs/`. Back up the entire `blobs/` directory.

### Crash Recovery

The server handles two recovery scenarios on startup:

1. **Staging versions with blobs on disk**: promoted to `pending` status automatically
2. **Staging versions with missing blobs**: deleted from the database
3. **Temp blob files** (`.tmp-*` from interrupted writes): deleted

No manual intervention is needed after a crash.

## Scaling Notes

- The server is single-process. For horizontal scaling, run multiple instances behind a load balancer with a shared database (replace SQLite with a networked alternative) or use separate instances with independent data directories.
- Rate limiting is in-memory and per-process. Multiple instances have independent rate limit counters.
- Config reload via `SIGHUP` only affects the process that receives the signal.
