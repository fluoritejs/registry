# Configuration

Two YAML files control the server. Both live in the repo root and are optional — missing keys use built-in defaults.

## deployment.yaml

Read once at startup. Changes require a restart.

```yaml
server:
  port: 3000
  publicBaseUrl: "http://localhost:3000"
  requireHttps: false

storage:
  dataDir: "./data"

admin:
  firstUserBecomesAdmin: true
  # OR
  # bootstrapAccount:
  #   namespace: admin
  #   passwordFromEnv: FLUORITE_BOOTSTRAP_PASSWORD  # or passwordFile: <path>; never put the password in this file
  #   displayName: "Administrator"
```

### server

| Key             | Default                 | Description                                                |
| --------------- | ----------------------- | ---------------------------------------------------------- |
| `port`          | `3000`                  | Port the HTTP server listens on.                           |
| `publicBaseUrl` | `http://localhost:3000` | Base URL used in webhook payloads and any generated links. |
| `requireHttps`  | `false`                 | Reject non-HTTPS requests from non-loopback clients.       |

### storage

| Key       | Default  | Description                                                                         |
| --------- | -------- | ----------------------------------------------------------------------------------- |
| `dataDir` | `./data` | Directory for the SQLite database and compiled extension blobs. Created if missing. |

### admin

| Key                     | Default | Description                                                                                                                                            |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `firstUserBecomesAdmin` | `true`  | First signup gets `type: admin` and `trusted: true`.                                                                                                   |
| `bootstrapAccount`      | `null`  | If set, creates an admin user on startup. Requires `namespace` and one of `password`, `passwordFromEnv`, or `passwordFile`; `displayName` is optional. |

`firstUserBecomesAdmin` and `bootstrapAccount` are mutually exclusive. Setting both, or setting `firstUserBecomesAdmin: false` without a `bootstrapAccount`, causes a startup error.

The bootstrap password is resolved at startup in this order: `passwordFromEnv` (an environment variable name), then `passwordFile` (a path whose first line is the password), falling back to `password` for explicit overrides. Placeholders (`change-me-immediately`, `REPLACE_ME`) and passwords shorter than 8 characters are rejected. Once the account exists the password is hashed and discarded, so the environment variable or secret file can be removed or rotated safely after first boot.

## config.yaml

Reloaded on `SIGHUP`. These settings take effect without restarting.

```yaml
auth:
  tokenTtl: 7d
  passwordHashing:
    algorithm: scrypt
    N: 16384
    r: 8
    p: 1
  rateLimit:
    login:
      maxAttempts: 5
      windowMinutes: 15
    signup:
      maxAttempts: 5
      windowMinutes: 15

publishing:
  firstPublishRequiresReview: true
  onePendingPerOwner: true
  namespacePattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$"
  packageIdPattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,63})$"

listings:
  defaultPageSize: 20
  maxPageSize: 50
  searchPageSize: 10

notifications:
  enabled: true
  includeUnreadCountHeader: true

webhooks:
  # Secrets are encrypted at rest with AES-256-GCM. Required to create webhooks.
  # Generate one with: openssl rand -hex 32
  encryptionKey: ""
  deliveryTimeoutMs: 5000
  maxRetries: 3
  retryBackoffMs: 2000
  maxResponseBodySize: 1048576

terms:
  dir: "./terms"
  enforce: false

server:
  shutdownTimeoutMs: 5000
  shutdownTimeoutMaxMs: 9000

logging:
  level: info
```

### auth

| Key                              | Default  | Description                                                                      |
| -------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `tokenTtl`                       | `7d`     | Session token lifetime. Accepts `s`, `m`, `h`, `d` suffixes (e.g. `30d`, `12h`). |
| `passwordHashing.algorithm`      | `scrypt` | Password hashing algorithm.                                                      |
| `passwordHashing.N`              | `16384`  | scrypt CPU/memory cost parameter.                                                |
| `passwordHashing.r`              | `8`      | scrypt block size parameter.                                                     |
| `passwordHashing.p`              | `1`      | scrypt parallelization parameter.                                                |
| `rateLimit.login.maxAttempts`    | `5`      | Max login attempts per IP+namespace before 429.                                  |
| `rateLimit.login.windowMinutes`  | `15`     | Rolling window for login rate limiting.                                          |
| `rateLimit.signup.maxAttempts`   | `5`      | Max signup attempts per IP before 429.                                           |
| `rateLimit.signup.windowMinutes` | `15`     | Rolling window for signup rate limiting.                                         |

Changing `tokenTtl` only affects new tokens. Existing tokens keep their original expiry.

Changing `passwordHashing` parameters only affects new passwords. Existing hashes retain their original parameters.

### publishing

| Key                          | Default                                  | Description                                                                             |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `firstPublishRequiresReview` | `true`                                   | New (untrusted) users' first publish goes to `pending` status and needs admin approval. |
| `onePendingPerOwner`         | `true`                                   | When `true`, each user can have at most one `pending` or `staging` version at a time across all extensions. When `false`, a user may have a pending version in several extensions, but only one per extension. |
| `namespacePattern`           | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` | Regex for validating user namespaces on signup.                                         |
| `packageIdPattern`           | `^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,63})$`  | Regex for validating extension IDs in manifests.                                        |

Namespace pattern: lowercase alphanumeric, 1-40 chars, hyphens allowed but not at start/end.

Package ID pattern: alphanumeric, 1-64 chars, dots/hyphens/underscores allowed but not at start.

### listings

| Key               | Default | Description                                              |
| ----------------- | ------- | -------------------------------------------------------- |
| `defaultPageSize` | `20`    | Page size when `limit` query param is not specified.     |
| `maxPageSize`     | `50`    | Maximum allowed page size. Requests for more are capped. |
| `searchPageSize`  | `10`    | Page size for extension search queries.                  |

### notifications

| Key                        | Default | Description                                                                 |
| -------------------------- | ------- | --------------------------------------------------------------------------- |
| `enabled`                  | `true`  | Whether notifications are created for version status changes.               |
| `includeUnreadCountHeader` | `true`  | Include `X-Unread-Notifications` header on auth and notification responses. |

### webhooks

| Key                   | Default   | Description                                                                                                                                                                                                      |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encryptionKey`       | `""`      | 32-byte hex key (AES-256-GCM) used to encrypt webhook secrets at rest. Generate with `openssl rand -hex 32`. Webhook creation is refused until this is configured; a non-empty malformed value fails at startup. |
| `deliveryTimeoutMs`   | `5000`    | HTTP timeout per webhook delivery attempt. The deadline is absolute across the initial request and any redirects within a single attempt.                                                                        |
| `maxRetries`          | `3`       | Retries after a failed delivery (0 = no retries).                                                                                                                                                                |
| `retryBackoffMs`      | `2000`    | Base delay between retries, multiplied by attempt number (linear backoff).                                                                                                                                       |
| `maxResponseBodySize` | `1048576` | Maximum response body bytes drained from a delivery (1 MiB). Larger responses abort the attempt and are retried.                                                                                                 |

### terms

| Key       | Default   | Description                                                                                                                                                                             |
| --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`     | `./terms` | Directory with `manifest.yaml` (versions) plus versioned markdown files (`tos.<version>.md`, `privacy.<version>.md`); legacy `tos.md` / `privacy.md` remain readable. Created on write. |
| `enforce` | `false`   | When `true`, authenticated actions require the user to have accepted the current terms and privacy versions.                                                                            |

When `enforce` is `true`, users receive `403 TERMS_ACCEPTANCE_REQUIRED` on authenticated endpoints until they call `POST /v0/terms/accept` with the current versions. Automation tokens are exempt. To force re-acceptance, bump the version for a document via `PATCH /v0/admin/terms` or `PATCH /v0/admin/privacy` (which also updates the on-disk content).

### server (runtime)

| Key                    | Default | Description                                                               |
| ---------------------- | ------- | ------------------------------------------------------------------------- |
| `shutdownTimeoutMs`    | `5000`  | How long to wait for in-flight requests before force-closing on shutdown. |
| `shutdownTimeoutMaxMs` | `9000`  | Hard upper bound for the shutdown timeout.                                |

### logging

| Key     | Default | Description                                                                         |
| ------- | ------- | ----------------------------------------------------------------------------------- |
| `level` | `info`  | One of `error`, `warn`, `info`, `debug`. Changes take effect immediately on SIGHUP. |
