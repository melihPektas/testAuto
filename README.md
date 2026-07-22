# test-orchestrator

A small, typed **test orchestration framework** — define test cases as JSON, run
them through pluggable *runners* (shell, HTTP APIs, n8n workflows, real browsers),
and get results as CLI output, JSON, or JUnit XML. Ships with a CLI, a live web
dashboard, and an **MCP server** so an AI agent (e.g. Claude) can drive it.

> TypeScript · pnpm workspaces · Turbo · Vitest · Playwright · MCP

---

## ✨ Features

- **Runner engine** — runs each test case's steps through a resolved runner with
  per-step **timeout**, **retry** (a step that passes only on retry is marked
  `flaky`), fail-fast, and lifecycle **events**.
- **Runners**
  - `shell` — runs a step's `action` as a shell command (pass on exit 0).
  - `http` — calls an API (`request` / `expectStatus` / `expectBody`).
  - `n8n` — POSTs to an n8n workflow **webhook** and passes on a 2xx response.
  - `browser` — drives a real Chromium via Playwright (`goto`, `expectStatus`,
    `expectTitle`, `expectSelector`, `expectText`, `click`, and a full `audit`).
- **Comprehensive UI audit** — one browser step checks title, rendered body,
  console/JS errors, broken images, link count, meta description, and mobile
  responsiveness.
- **Reporters** — `json` and `junit` file reports, plus a live console reporter.
- **Generators** — produce test-case files from templates or from URLs.
- **Ingest** — scan a project, detect its framework (vitest/jest/playwright/mocha),
  and turn existing test files into orchestrator test cases.
- **MCP server** — exposes `run_tests`, `list_tests`, `generate_tests`, `test_url`,
  and `ingest_project` as tools an MCP client can call.
- **Schema** — JSON Schema (draft 2020-12) + AJV validators for config & test cases.
- **CLI** — `init`, `generate`, `run`, `report`, `plugin`.
- **Web dashboard** — browse test cases, run them, and watch results stream live
  over Server-Sent Events.

## 📦 Monorepo layout

| Package | Description |
| --- | --- |
| `@test-orchestrator/schema` | JSON Schemas + AJV validators (config, test-case) |
| `@test-orchestrator/core` | Runtime: engine, runners, reporters, generators, ingest, registry, hooks, errors |
| `@test-orchestrator/cli` | Command-line entry point (`test-orchestrator` / `to`) |
| `@test-orchestrator/web` | Dashboard API server + UI (live SSE) |
| `@test-orchestrator/browser` | Playwright browser runner + URL UI-test generator |
| `@test-orchestrator/mcp` | MCP server exposing the orchestrator as tools |

## 🚀 Quick start

```bash
pnpm install
pnpm build

# scaffold a config, generate test cases, run them (with a JUnit report)
node packages/cli/bin/test-orchestrator.js init
node packages/cli/bin/test-orchestrator.js generate login logout -d cases
node packages/cli/bin/test-orchestrator.js run -t cases --reporter junit --out results.xml
```

### Web dashboard

```bash
# from a directory containing test-orchestrator.config.json + *.test-case.json
PORT=4600 node packages/web/dist/server.js   # open http://localhost:4600
```

### MCP server (drive it from an AI agent)

Register in your MCP client (e.g. a project `.mcp.json`):

```json
{
  "mcpServers": {
    "test-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/bin/mcp.js"]
    }
  }
}
```

Tools: `run_tests`, `list_tests`, `generate_tests`, `test_url` (comprehensive
browser UI audit of a URL), `ingest_project` (adopt an existing test suite).

## 🧩 Config & test-case format

`test-orchestrator.config.json`

```json
{
  "version": "1.0",
  "name": "my-tests",
  "runners": [
    { "name": "default", "type": "shell" },
    { "name": "api", "type": "http", "options": { "baseUrl": "http://localhost:3000" } },
    { "name": "ui", "type": "browser" },
    { "name": "deploy", "type": "n8n", "options": { "baseUrl": "http://localhost:5678" } }
  ]
}
```

`*.test-case.json` examples:

```json
{ "id": "hello", "version": "1.0", "name": "shell", "runner": "default",
  "steps": [{ "action": "echo hello" }] }
```

```json
{ "id": "api-health", "version": "1.0", "name": "backend", "runner": "api",
  "steps": [
    { "action": "request", "target": "GET /health" },
    { "action": "expectStatus", "value": 200 },
    { "action": "expectBody", "value": "healthy" }
  ] }
```

```json
{ "id": "ui-smoke", "version": "1.0", "name": "UI audit", "runner": "ui",
  "steps": [
    { "action": "goto", "value": "https://example.com" },
    { "action": "expectStatus", "value": 200 },
    { "action": "audit" }
  ] }
```

## 🛠️ Development

```bash
pnpm build        # tsc -b across all packages (turbo)
pnpm test         # vitest across all packages
pnpm check-types  # type-check only
```

The `browser` package needs Chromium: `pnpm --filter @test-orchestrator/browser exec playwright install chromium`.

CI (GitHub Actions) builds, tests, and runs a CLI end-to-end smoke on every push
and pull request.

## 📄 License

MIT
