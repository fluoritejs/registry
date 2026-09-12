# Contributing

Thanks for contributing to Fluorite Registry.

## Prerequisites

- Node.js 22.13.0 through 22.x, or 24 and newer, with npm
- A dedicated, disposable PostgreSQL database for running the test suite. Each run creates and then drops its own schema, so the database it connects to must not be a shared database whose data you rely on.

## Getting Started

1. Fork the repository and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/registry.git
   cd registry
   ```

2. Add the upstream remote:

   ```bash
   git remote add upstream https://github.com/fluoritejs/registry.git
   ```

3. Install dependencies:

   ```bash
   npm ci
   ```

4. Create a branch for your work:

   ```bash
   git checkout -b fix/issue-42
   ```

## Project Layout

| Path              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `src/server.js`   | App assembly, middleware, startup, shutdown, SIGHUP reload       |
| `src/routes/`     | Express routers. One file per resource (auth, users, extensions) |
| `src/db.js`       | PostgreSQL schema, prepared statements, crash recovery           |
| `src/auth.js`     | Password hashing, tokens, rate limiting, auth middleware         |
| `src/config.js`   | `deployment.yaml` / `config.yaml` loading and defaults           |
| `src/manifest.js` | AST-based manifest extraction from compiled extension source     |
| `src/webhooks.js` | Webhook delivery, signatures, retry logic                        |
| `test/`           | Integration tests. Each route file has a matching `*.test.js`    |

## Running the Server Locally

```bash
npm start
```

The server loads `deployment.yaml` and `config.yaml` from the repo root if present, otherwise uses defaults for the app code. It needs a PostgreSQL database; point it at one via `database.connectionString` in `deployment.yaml` or the `FLUORITE_DATABASE_URL` environment variable (default connection settings assume a local `fluorite` database). See [setup.md](setup.md) for the first-run flow.

## Testing

Tests use the built-in `node:test` runner. Each test file creates an isolated schema (`test_<random>`) on the server from `DATABASE_URL` and drops it, cascading, on teardown. Setting `DATABASE_URL` is the explicit opt-in that points the suite at a given server; without it, tests fall back to `postgres://fluorite:fluorite@localhost:5432/fluorite`. The suite only ever creates and drops schemas prefixed `test_` inside the target database and never touches objects outside them, but teardown does drop, so point `DATABASE_URL` at a dedicated disposable database, not at a shared one you care about.

Run all tests:

```bash
npm test
```

Run a single test file:

```bash
node --test test/auth.test.js
```

Write tests against the helpers in `test/helpers.js` — `createTestEnv()` (async, `await env.cleanup()` in teardown), `request()`, `signup()`, and `login()` cover the common setup. The `fixtures/` directory holds sample compiled extensions for publish tests.

## Code Style

This repo uses [Prettier](https://prettier.io) and [ESLint](https://eslint.org) with a flat config. There is no `.editorconfig`; rely on the formatting commands below.

```bash
npm run lint          # run ESLint
npm run format        # format everything with Prettier
npm run format:check  # verify formatting (CI check)
```

Write code to match the surrounding file — naming, comment density, and error handling style should look at home next to the code you're changing, not polished to a higher standard than the rest of the file.

## Commit Messages

Keep commits small and focused. Follow the existing history — concise summaries in the present tense (`Add X endpoint`, `Fix Y crash`), with context in the body when it isn't obvious from the subject.

## Submitting

1. Before pushing, run the same checks CI runs:

   ```bash
   npm run lint
   npm run format:check
   npm test
   ```

2. Push your branch and open a pull request against `main`.

3. In the PR description, say what the change does and any behavior it affects. If it changes the API or configuration, update the relevant files under `docs/` and `openapi/v0.yaml` in the same PR.

CI runs ESLint, Prettier, and the test suite on every push to a PR. The test job only runs after lint and format pass, so a formatting failure shows up first.

## Docs

Documentation lives in `docs/` alongside the README. A change to a documented behavior should update the matching doc page — `docs/api-reference.md` for endpoints, `docs/configuration.md` for config keys, `docs/setup.md` for operation, `docs/extension-authors.md` for publishing.
