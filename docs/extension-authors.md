# Publishing Extensions

Most of these things can be done with Fluorite Compiler. Note that you will need at least Fluorite Compiler v0.2.0 to perform registry-related actions.

## Account Setup

```bash
# Create an account
curl -X POST \
  -H "Content-Type: application/json" \
  -d "{\"namespace\": \"myname\", \"password\": \"$GENERATED_PASSWORD\"}" \
  http://localhost:3000/v0/auth/signup
```

The response includes a `token`. Save it for subsequent requests.

## Manifest Format

Every extension source file must contain a Fluorite manifest — an object literal with `id`, `name`, and `version` assigned to a `Fluorite` global. The server parses the source AST to extract it; your code is never executed. **If you're using Fluorite Compiler like most consumers will, you won't have to worry about this part.**

```js
(function (Scratch) {
  "use strict";

  const Fluorite = {
    meta: {
      class: "MyExtension",
      name: "My Extension",
      id: "my-extension",
      version: "1.0.0",
      license: "Apache-2.0",
      description: "What this extension does"
    },
    assets: { "icon.svg": "data:image/svg+xml;base64,..." }
  };

  class MyExtension {
    getInfo() {
      return { id: Fluorite.meta.id, name: Fluorite.meta.name, ... };
    }
  }

  Scratch.extensions.register(new MyExtension());
})(Scratch);
```

### Required Fields

| Field     | Validation                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`      | Matches `publishing.packageIdPattern` (default: `^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,63})$`). 1-64 characters. Alphanumeric, dots, hyphens, underscores. |
| `name`    | Any string.                                                                                                                                          |
| `version` | Valid semver (e.g. `1.0.0`, `2.1.0-beta.1`).                                                                                                         |

### Optional Fields

| Field         | Description                                        |
| ------------- | -------------------------------------------------- |
| `license`     | SPDX license identifier. Defaults to empty string. |
| `description` | Short text description. Defaults to empty string.  |

## Publishing

Send your compiled extension source as the raw request body:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/javascript" \
  --data-binary @my-extension.js \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions
```

The URL path uses your namespace and the extension ID from the manifest.

### Publishing with fluorite-compiler

Make sure to log in (`npx fluorite-compiler login`) if you haven't already.

```bash
npx fluorite-compiler publish
```

### What Happens on Publish

1. The server parses your source and extracts the manifest
2. The manifest `id` must match the `:id` in the URL
3. The version must not already exist
4. If `onePendingPerOwner` is enabled, you can only have one pending version at a time across all your extensions
5. Your source is saved to disk and a database record is created

### First Publish

If `publishing.firstPublishRequiresReview` is enabled (the default), your first publish goes to `pending` status. An admin reviews it. Once approved, you become `trusted` and all future publishes go straight to `published`.

If the admin disables this setting, or if you're added as a trusted user by an admin, your first publish is immediately `published`.

## Fetching Extensions

### As JSON metadata

```bash
curl http://localhost:3000/v0/extensions/@myname/my-extension/versions/1.0.0
```

### As compiled JavaScript

```bash
curl -H "Accept: application/javascript" \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions/1.0.0
```

### Latest version

Use `latest` instead of a version number:

```bash
curl -H "Accept: application/javascript" \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions/latest
```

This resolves to the most recent published, non-yanked version.

## Yanking

Yanking hides a version from public listings and `latest` resolution. The version still exists and can be fetched directly.

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": true, "reason": "Bug in this version"}' \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions/1.0.0/yank
```

To un-yank (make it visible again):

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"yanked": false}' \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions/1.0.0/yank
```

## Deleting

Delete a single version:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/v0/extensions/@myname/my-extension/versions/1.0.0
```

Delete the entire extension (all versions):

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/v0/extensions/@myname/my-extension
```

## Automation Tokens

For CI/CD pipelines, create an automation token instead of using your session token:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Publisher", "scopes": ["publish"]}' \
  http://localhost:3000/v0/auth/tokens
```

Use the returned `token` value in the `Authorization: Bearer` header. Automation tokens don't expire and track `lastUsedAt`. Revoke them when no longer needed.

## Notifications

When your version is approved or rejected, you receive a notification. Check it:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v0/notifications"
```

The `X-Unread-Notifications` header on authenticated responses also tells you the count.

Mark as read:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/v0/notifications/1
```

## Error Handling

All error responses have this structure:

```json
{
  "error": {
    "code": "VERSION_EXISTS",
    "message": "Version 1.0.0 already exists.",
    "field": "version"
  }
}
```

Common publish errors:

| Status | Code                     | Fix                                                      |
| ------ | ------------------------ | -------------------------------------------------------- |
| 400    | `INVALID_MANIFEST`       | Add or fix the `Fluorite.manifest` object in your source |
| 400    | `MANIFEST_MISMATCH`      | Make sure the manifest `id` matches the URL path         |
| 400    | `VERSION_TOO_LOW`        | Bump the version above the highest currently published   |
| 403    | `VERSION_PENDING_REVIEW` | Wait for your current pending version to be reviewed     |
| 403    | `FORBIDDEN`              | You can only publish to your own namespace               |
| 404    | `NOT_FOUND`              | Your namespace doesn't exist — sign up first             |
| 409    | `VERSION_EXISTS`         | Bump the version number in your manifest                 |
