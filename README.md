# Fluorite Registry

> A Node web registry for extensions created with Fluorite Compiler.

## Features

**Extension Publishing & Distribution**

- Publish compiled extensions (max 1 MB) as raw JavaScript; the server parses the source AST to extract the Fluorite manifest — your code is never executed
- Serve extensions as JSON metadata or as byte-for-byte compiled JavaScript (`Accept: application/javascript`), with a `latest` shortcut that resolves the most recent published, non-yanked version
- Search extensions by namespace, package ID, name, and description, with cursor-based pagination on all list endpoints
- Per-version download counters and public aggregate stats (published/pending counts, authors, total downloads)

**Moderation & Trust Model**

- First publishes held for admin review; once approved, the author becomes `trusted` and future publishes go live immediately
- Admin moderation worklist (`GET /v0/versions?status=...`) plus approve/reject with an optional rejection reason
- Optional `onePendingPerOwner` rule and enforced package ID / namespace / semver validation via configurable patterns

**Version Management**

- Yank/un-yank versions with an optional reason (yanked versions disappear from listings and `latest` but remain fetchable), plus deleting individual versions or entire extensions

**Security & Authentication**

- Namespaced accounts with scrypt password hashing, configurable token TTL, and session management (list, revoke, revoke-all)
- Automation tokens for CI/CD with fine-grained scopes (currently `publish`) and `lastUsedAt` tracking; password changes revoke all sessions and tokens
- Login/signup rate limiting by IP and namespace, and optional HTTPS enforcement for non-loopback requests

**Notifications & Webhooks**

- In-app notifications on version approve/reject/publish with read/unread tracking and an `X-Unread-Notifications` header on authenticated responses
- Extensible webhook system firing on version lifecycle events (`version.published`, `version.pending`, `version.approved`, `version.rejected`, `version.yanked`) with HMAC-SHA256 signatures and automatic retries with backoff

**Legal & Compliance**

- Optional Terms of Service and Privacy Policy served from versioned markdown files, with per-user acceptance tracking and forced re-acceptance when documents change
- Admin endpoints to publish documents and bump versions; enforcement is toggleable and exempts automation tokens

**Admin & User Management**

- Admin bootstrap (`firstUserBecomesAdmin` or a configured `bootstrapAccount`), role and trusted-status management, and direct user creation

**Operations**

- PostgreSQL-backed metadata with blob files written atomically (temp-file-then-rename) and automatic crash recovery on startup
- Containerized deployment via Docker/Podman (Compose), graceful shutdown on `SIGTERM`/`SIGINT`, and live config reload on `SIGHUP`

## Built With

- [Node.js](https://nodejs.org): Runtime environment
- [Express.js](https://expressjs.com/): Web server

## Getting Started

### Prerequisites

- Node.js (22.13.0 through 22.x, or 24 and newer)
- npm
- A running PostgreSQL server

### Installation

#### Method 1: From Source (Not Recommended)

1. Clone the repository:

   ```bash
   git clone https://github.com/fluoritejs/registry
   ```

2. `cd` into the cloned repository:

   ```bash
   cd registry
   ```

3. Install dependencies:

   ```bash
   npm ci
   ```

4. Start the registry:

   ```bash
   npm start
   ```

#### Method 2: From Compose

> **Important:** You will need Docker or Podman for this.

1. Clone the repository (the [example compose file](compose.example.yaml), [deployment file](deployment.example.yaml), and [config file](config.example.yaml) live in the checkout), then copy those files into the directory you'll use for registry storage, renaming the `.example` suffix off:

   ```bash
   git clone https://github.com/fluoritejs/registry
   mkdir registry-storage
   cp registry/compose.example.yaml registry-storage/compose.yaml
   cp registry/deployment.example.yaml registry-storage/deployment.yaml
   cp registry/config.example.yaml registry-storage/config.yaml
   ```

2. Make sure to configure deployment and general configuration data.

3. Start the server:

   ```bash
   cd registry-storage
   docker compose up -d
   ```

   OR if you're using Podman:

   ```bash
   cd registry-storage
   podman compose up -d
   ```

## Usage

For guidance on setup and API documentation, see the [documentation](docs/).

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](docs/CONTRIBUTING.md) to get started.

## License

Fluorite Registry is Free Software distributed under the [Apache 2.0](LICENSE) license.
