# Setting Up a Fluorite Registry

## Prerequisites

- Node.js 22.13.0+ or 24+
- A POSIX shell (Linux, macOS, WSL)

## Install

```bash
git clone https://github.com/fluoritejs/registry.git
cd registry
npm install
```

`npm install` compiles the `better-sqlite3` native addon. On Linux you need a C compiler and Python 3 available (the usual build-essential toolchain).

## Directory Structure

After install, create these files in the repo root:

- `deployment.yaml` — server address, storage path, admin bootstrap
- `config.yaml` — auth settings, publishing rules, logging

You can just copy them from `deployment.example.yaml` and `config.example.yaml` and edit them from there. Both are optional. Without them the server uses built-in defaults (port 3000, first user becomes admin, SQLite in `./data`).

## First Run

```bash
npm start
# You can also use Docker/Podman (see README.md).
```

The server:

1. Loads `deployment.yaml` and `config.yaml` (falls back to defaults for missing keys)
2. Creates `data/registry.sqlite` and all tables if they don't exist
3. Cleans up any leftover temp blob files from a previous crash
4. Promotes any orphaned `staging` versions whose blobs are on disk to `pending`
5. Optionally creates a bootstrap admin account
6. Starts listening

### Admin Bootstrap

There are two ways to get your first admin user:

**Option A — `firstUserBecomesAdmin` (default)**

The first account to sign up automatically gets `type: admin` and `trusted: true`. This is the default when `deployment.yaml` is absent or has `admin.firstUserBecomesAdmin: true`.

After creating the account, disable this for production:

```yaml
# deployment.yaml
admin:
  firstUserBecomesAdmin: false
  bootstrapAccount:
    namespace: admin
    password: changeme123
```

**Option B — bootstrapAccount**

Set `firstUserBecomesAdmin: false` and provide a `bootstrapAccount`. The server creates this user on startup if it doesn't already exist. The user gets `type: admin` and `trusted: true`.

The two options are mutually exclusive. Setting both or neither (with `firstUserBecomesAdmin: false` and no `bootstrapAccount`) causes a startup error.

## Data Directory

The `storage.dataDir` path (default `./data`) holds:

```
data/
  registry.sqlite          # the database
  blobs/
    <namespace>/
      <extension-id>/
        <version>.js       # compiled extension source
```

Blob files are written atomically via a temp-file-then-rename pattern. If the server crashes mid-write, temp files (`.tmp-*`) are cleaned up on the next startup.

## Signals

| Signal               | Action                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `SIGTERM` / `SIGINT` | Graceful shutdown: stops accepting new connections, closes DB, exits                                     |
| `SIGHUP`             | Reloads `config.yaml` (logging level, rate limits, publishing rules, etc.) — does not restart the server |

Shutdown has a timeout (default 5 seconds, capped at 9 seconds). If the timeout fires, the process exits with code 1.

## HTTPS

Non-loopback requests require HTTPS when `server.requireHttps: true` in `deployment.yaml`. Loopback requests (`127.0.0.1`, `::1`) are exempt. Put the server behind a reverse proxy (nginx, Caddy) for TLS termination in production.
