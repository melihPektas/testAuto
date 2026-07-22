# test-orchestrator

A small, typed **test orchestration framework** — define test cases as JSON, run
them through pluggable *runners* (shell commands, n8n workflows, …), and get
results as CLI output, JSON, or JUnit XML. Ships with a CLI and a live web
dashboard.

> TypeScript · pnpm workspaces · Turbo · Vitest · zero-runtime-dependency core

---

## ✨ Features

- **Runner engine** — runs each test case's steps through a resolved runner with
  per-step **timeout**, **retry** (a step that passes only on retry is marked
  `flaky`), fail-fast, and lifecycle **events**.
- **Runners**
  - `shell` — runs a step's `action` as a shell command (pass on exit 0).
  - `n8n` — POSTs to an n8n workflow **webhook** and passes on a 2xx response.
- **Reporters** — `json` and `junit` file reports, plus a live console reporter.
- **Generators** — produce test-case files from templates (`executeGenerators`).
- **Schema** — JSON Schema (draft 2020-12) + AJV validators for config & test cases.
- **CLI** — `init`, `generate`, `run`, `report`, `plugin`.
- **Web dashboard** — browse test cases, run them, and watch results stream live
  over Server-Sent Events.

## 📦 Monorepo layout

| Package | Description |
| --- | --- |
| `@test-orchestrator/schema` | JSON Schemas + AJV validators (config, test-case) |
| `@test-orchestrator/core` | Runtime: engine, runners, reporters, generators, registry, hooks, errors |
| `@test-orchestrator/cli` | Command-line entry point (`test-orchestrator` / `to`) |
| `@test-orchestrator/web` | Dashboard API server + UI |

## 🚀 Quick start

```bash
pnpm install
pnpm build

# scaffold a config in the current directory
node packages/cli/bin/test-orchestrator.js init

# generate test cases
node packages/cli/bin/test-orchestrator.js generate login logout -d cases

# run them (with a JUnit report)
node packages/cli/bin/test-orchestrator.js run -t cases --reporter junit --out results.xml
```

### Web dashboard

```bash
# from a directory containing test-orchestrator.config.json + *.test-case.json
PORT=4600 node packages/web/dist/server.js
# open http://localhost:4600
```

## 🧩 Config & test-case format

`test-orchestrator.config.json`

```json
{
  "version": "1.0",
  "name": "my-tests",
  "runners": [
    { "name": "default", "type": "shell" },
    { "name": "deploy", "type": "n8n", "options": { "baseUrl": "http://localhost:5678" } }
  ]
}
```

`*.test-case.json`

```json
{
  "id": "hello",
  "version": "1.0",
  "name": "hello world",
  "runner": "default",
  "steps": [{ "action": "echo hello" }]
}
```

For an n8n runner, a step's `action` is the webhook path and `value` is the JSON
body sent to the workflow:

```json
{ "id": "deploy", "version": "1.0", "name": "deploy", "runner": "deploy",
  "steps": [{ "action": "deploy-webhook", "value": { "env": "staging" } }] }
```

## 🛠️ Development

```bash
pnpm build        # tsc -b across all packages (turbo)
pnpm test         # vitest across all packages
pnpm check-types  # type-check only
```

CI (GitHub Actions) builds, tests, and runs a CLI end-to-end smoke on every push
and pull request.

## 📄 License

MIT
