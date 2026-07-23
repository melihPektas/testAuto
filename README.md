# test-orchestrator

A small, typed **test orchestration framework** — define test cases as JSON, run
them through pluggable _runners_ (shell, HTTP APIs, n8n workflows, real browsers),
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
- **Site exploration** — crawl same-origin pages with a real browser and record
  every link, heading and form field, then generate a test case per page and form.
- **LLM test author** — hand that exploration to a model and get _realistic_
  scenarios back: negative cases, multi-step journeys, things rule-based
  generation cannot invent. **Model output is never trusted** — every scenario
  must pass the JSON Schema, an allowlist of runner actions, and a same-origin
  check before it is kept; the rest come back as `rejected` with a reason.
- **MCP server** — exposes `run_tests`, `list_tests`, `generate_tests`, `test_url`,
  `explore_site`, `author_tests`, and `ingest_project` as tools an MCP client can call.
- **Schema** — JSON Schema (draft 2020-12) + AJV validators for config & test cases.
- **Combination matrix** — for a listing page, the model identifies the _axes_
  (search terms, categories, brands) and the cross-product is expanded locally.
  One model call yields hundreds of genuinely distinct cases; asking a model for
  hundreds of cases directly just yields repetition.
- **Triage** — when a test fails, classify what the failure _means_:
  `product-bug`, `test-bug`, `flaky`, `environment` or `test-data`. Unambiguous
  failures are decided by rule with no model call at all.
- **CSV export** — hand the generated inventory to a QA team or a test-management
  tool (`--per-step` for step-level rows).
- **CLI** — `init`, `generate`, `author`, `matrix`, `run`, `triage`, `export`, `report`, `plugin`.
- **Web dashboard** — browse test cases, run them, and watch results stream live
  over Server-Sent Events.

## 📦 Monorepo layout

| Package                      | Description                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `@test-orchestrator/schema`  | JSON Schemas + AJV validators (config, test-case)                                |
| `@test-orchestrator/core`    | Runtime: engine, runners, reporters, generators, ingest, registry, hooks, errors |
| `@test-orchestrator/cli`     | Command-line entry point (`test-orchestrator` / `to`)                            |
| `@test-orchestrator/web`     | Dashboard API server + UI (live SSE)                                             |
| `@test-orchestrator/browser` | Playwright browser runner, site explorer, URL UI-test generator                  |
| `@test-orchestrator/agent`   | LLM test author: turns an exploration into validated test cases                  |
| `@test-orchestrator/mcp`     | MCP server exposing the orchestrator as tools                                    |

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
browser UI audit of a URL), `explore_site` (crawl and generate tests from what is
found), `author_tests` (LLM-written scenarios, see below), `ingest_project`
(adopt an existing test suite).

### LLM test author

`author_tests` explores a site, then asks a model to write scenarios for each
page. It talks to any **OpenAI-compatible** endpoint — a local Ollama needs no
key:

```bash
export TEST_ORCHESTRATOR_LLM_URL=http://localhost:11434/v1
export TEST_ORCHESTRATOR_LLM_MODEL=qwen2.5-coder:14b
```

Prefer a **non-reasoning** coder model. Authoring is pure JSON generation, and a
reasoning model burns most of its time on thinking tokens nobody reads — on the
same machine, one small reply took **28.7s** from `qwen3:14b` versus **6.5s**
from `qwen2.5-coder:14b`.

Accepted scenarios are written to `<dir>/authored/`. Rejected ones are never
written; they are returned with the reason they failed validation.

### Combination matrix

For a listing or search page, `matrix` asks the model for the page's _axes_
rather than for test cases, then expands the cross-product locally:

```bash
node packages/cli/bin/test-orchestrator.js matrix https://example.com/products -l 500
node packages/cli/bin/test-orchestrator.js run -t matrix
node packages/cli/bin/test-orchestrator.js export -t matrix -o test-cases.csv
```

Both halves are grounded in the page that was actually explored: a filter URL
must appear verbatim in the page's own link list, and the result selector must
be one of the selectors observed repeating on the page. Invented ones are
dropped with a reason.

Measured on a real listing page: **500 distinct cases from one model call in
2m14s.**

### Triage

A failing suite is a pile of error strings until someone decides what each one
means. `triage` does that pass:

```bash
node packages/cli/bin/test-orchestrator.js run -t authored --reporter json --out results.json
node packages/cli/bin/test-orchestrator.js triage -i results.json -t authored
```

Rules go first, and they are not a shortcut — a 403, a 5xx, a DNS failure or a
step that only passed on retry has one correct reading, and a regex gives it in
microseconds. Measured: **8 blocked cases triaged in 0.22s with zero model
calls**; the same eight through a local model would have taken about four
minutes.

What needs judgement goes to the model _with the rest of the run attached_. That
detail decides the verdict: asked about a failed login in isolation the model
called it a product bug, and shown that "log in with invalid credentials" had
passed in the same run — proving the login flow works — it correctly called the
same failure `test-data`, naming the invented credentials.

A model that is slow, unreachable or off-contract yields a low-confidence result
rather than an exception. Triage must never break the run that produced the
failure.

### Try it locally

`examples/demoshop` is a two-page app with a login that really does reject bad
credentials:

```bash
node examples/demoshop/server.mjs
cd examples/demoshop && node ../../packages/cli/bin/test-orchestrator.js author http://localhost:4700/ -p 2
node ../../packages/cli/bin/test-orchestrator.js run -t authored
```

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
{
  "id": "hello",
  "version": "1.0",
  "name": "shell",
  "runner": "default",
  "steps": [{ "action": "echo hello" }]
}
```

```json
{
  "id": "api-health",
  "version": "1.0",
  "name": "backend",
  "runner": "api",
  "steps": [
    { "action": "request", "target": "GET /health" },
    { "action": "expectStatus", "value": 200 },
    { "action": "expectBody", "value": "healthy" }
  ]
}
```

```json
{
  "id": "ui-smoke",
  "version": "1.0",
  "name": "UI audit",
  "runner": "ui",
  "steps": [
    { "action": "goto", "value": "https://example.com" },
    { "action": "expectStatus", "value": 200 },
    { "action": "audit" }
  ]
}
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
