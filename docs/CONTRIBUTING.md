# Contributing

Thanks for contributing to Fluorite Registry.

## Prerequisites

- Node.js 22.13.0+ or 24+, with npm
- A C compiler and Python 3 on Linux (needed to compile the `better-sqlite3` native addon during install)

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
| `src/db.js`       | SQLite schema, migrations, prepared statements, crash recovery   |
| `src/auth.js`     | Password hashing, tokens, rate limiting, auth middleware         |
| `src/config.js`   | `deployment.yaml` / `config.yaml` loading and defaults           |
| `src/manifest.js` | AST-based manifest extraction from compiled extension source     |
| `src/webhooks.js` | Webhook delivery, signatures, retry logic                        |
| `test/`           | Integration tests. Each route file has a matching `*.test.js`    |

## Running the Server Locally

```bash
npm start
```

The server loads `deployment.yaml` and `config.yaml` from the repo root if present, otherwise uses defaults (port 3000, SQLite in `./data`). See [setup.md](setup.md) for the first-run flow.

## Testing

Tests use the built-in `node:test` runner and spin up an in-memory Express app with a temporary SQLite database, so they don't touch your real `data/` directory.

Run all tests:

```bash
npm test
```

Run a single test file:

```bash
node --test test/auth.test.js
```

Write tests against the helpers in `test/helpers.js` — `createTestEnv()`, `request()`, `signup()`, and `login()` cover the common setup. The `fixtures/` directory holds sample compiled extensions for publish tests.

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
