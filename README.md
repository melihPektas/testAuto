# test-orchestrator

A **QA agent** that writes UI tests for an application it has never seen, runs
them, decides what each failure means, and fixes the ones that are the test's
fault.

Underneath it is a small, typed test framework: test cases are JSON, they run
through pluggable _runners_ (shell, HTTP, n8n workflows, real browsers), and
results come out as console output, JSON, JUnit XML or CSV. There is a CLI, a
live web dashboard, and an MCP server so an AI client can drive the whole thing.

> TypeScript · pnpm workspaces · Turbo · Vitest · Playwright · MCP

---

## The loop

```
explore  →  author  →  run  →  triage  →  repair
```

| Step        | What happens                                                                             |
| ----------- | ---------------------------------------------------------------------------------------- |
| **explore** | A real browser crawls the site and records links, headings, forms and repeated selectors |
| **author**  | A model turns that into realistic scenarios — negative cases, multi-step journeys        |
| **run**     | Test cases execute, N at a time; a failing browser step captures evidence                |
| **triage**  | Each failure is classified: product bug, test bug, flaky, environment or test data       |
| **repair**  | Where the test is at fault, a stale selector is fixed, verified, and written back        |

Every model output crosses a validation boundary before it is used. The model
proposes; the schema, an action allowlist, a same-origin check and the page's own
DOM dispose.

## ✨ Features

**Generating tests**

- **Site exploration** — crawl same-origin pages with a real browser and record
  every link, heading, form field and repeated selector. Links are sampled across
  distinct URL _shapes_, so a page with 1400 links surfaces its categories rather
  than 400 product pages.
- **LLM test author** — realistic scenarios, including the negative cases and
  multi-step journeys rule-based generation cannot invent. Model output is never
  trusted: every scenario must pass the JSON Schema, an allowlist of runner
  actions and a same-origin check, or it comes back as `rejected` with a reason.
- **Combination matrix** — for a listing page, the model identifies the _axes_
  (search terms, categories, brands) and the cross-product is expanded locally.
  Asking a model for 500 cases yields repetition; asking for the axes yields 500
  genuinely distinct cases from one call.
- **Ingest** — scan an existing project, detect its framework
  (vitest/jest/playwright/mocha), and adopt its test files.
- **Generators** — produce test-case files from templates or from URLs.

**Running tests**

- **Runner engine** — per-step **timeout**, **retry** (a step that passes only on
  retry is marked `flaky`), fail-fast, and lifecycle **events** and **hooks**.
- **Runners** — `shell` (exit 0 passes), `http` (`request` / `expectStatus` /
  `expectBody`), `n8n` (POST to a workflow webhook), and `browser`: a real
  Chromium with 19 actions covering navigation, form filling, assertions on
  title, text, selectors, URL, element counts, and a full `audit`.
- **Comprehensive UI audit** — one step checks title, rendered body, console
  errors, broken images, link count, meta description and mobile responsiveness,
  reporting every finding rather than stopping at the first.
- **Parallel execution** — run N test cases at once with `-j`. Each lane gets its
  own runner instance, because a runner holds state for the test it is running.
- **Reporters** — `json` and `junit` files, plus a live console reporter.

**Understanding failures**

- **Failure evidence** — a failing browser step captures a screenshot and the
  facts that bear on the failure: where the browser was, how much the page
  rendered, how many elements the selector matched, and which _related_ selectors
  the page does contain.
- **Triage** — classify what a failure means. Unambiguous failures are decided by
  rule with no model call at all; the rest are judged with the whole run attached.
- **Self-healing, narrowly** — repair a stale selector, verify it by re-running,
  and only then offer to write it. It cannot weaken an assertion.

**Interfaces**

- **CLI** — `init`, `generate`, `author`, `matrix`, `run`, `triage`, `repair`,
  `export`, `report`, `plugin`.
- **MCP server** — `list_tests`, `run_tests`, `generate_tests`, `test_url`,
  `explore_site`, `author_tests`, `triage_failures`, `ingest_project`.
- **Web dashboard** — browse test cases, edit them, run them, watch results
  stream live over Server-Sent Events.
- **CSV export** — hand the inventory to a QA team or a test-management tool.
- **Schema** — JSON Schema (draft 2020-12) + AJV validators for config and test
  cases.

## 📦 Monorepo layout

| Package                      | Description                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `@test-orchestrator/schema`  | JSON Schemas + AJV validators (config, test-case)                               |
| `@test-orchestrator/core`    | Engine, runners, reporters, generators, ingest, registry, hooks, CSV, errors    |
| `@test-orchestrator/browser` | Playwright runner, site explorer, failure evidence, URL test generator          |
| `@test-orchestrator/agent`   | The model-backed half: author, matrix, triage, repair — each behind a validator |
| `@test-orchestrator/cli`     | Command-line entry point (`test-orchestrator` / `to`)                           |
| `@test-orchestrator/web`     | Dashboard API server + UI (live SSE)                                            |
| `@test-orchestrator/mcp`     | MCP server exposing the orchestrator as tools                                   |

## 🚀 Quick start

```bash
pnpm install
pnpm build
pnpm --filter @test-orchestrator/browser exec playwright install chromium
```

Then run the whole loop against the bundled example app:

```bash
node examples/demoshop/server.mjs
```

```bash
cd examples/demoshop
export TEST_ORCHESTRATOR_LLM_URL=http://localhost:11434/v1

node ../../packages/cli/bin/test-orchestrator.js author http://localhost:4700/ -p 2
node ../../packages/cli/bin/test-orchestrator.js run -t authored -j 4 --reporter json --out results.json
node ../../packages/cli/bin/test-orchestrator.js triage -i results.json -t authored
node ../../packages/cli/bin/test-orchestrator.js repair -i results.json -t authored
```

`examples/demoshop` is a four-page app — home, about, sign-in and account — whose
login really does reject bad credentials, so failures there are real failures.

## 🤖 Connecting a model

Anything **OpenAI-compatible**. A local Ollama needs no key:

```bash
export TEST_ORCHESTRATOR_LLM_URL=http://localhost:11434/v1
export TEST_ORCHESTRATOR_LLM_MODEL=qwen2.5-coder:14b
```

Prefer a **non-reasoning** coder model. All of this is JSON generation, and a
reasoning model spends most of its time on thinking tokens nobody reads — on the
same machine, one small reply took **28.7s** from `qwen3:14b` versus **6.5s**
from `qwen2.5-coder:14b`.

Generation runs at temperature 0.2, where variety is the point. Judgement —
triage and repair — runs at **0**. That is not a detail: at 0.2 the same failure
was triaged `test-bug` on one run and `product-bug` on the next, which is not an
acceptable basis for editing files.

## 📝 Authoring tests

```bash
node packages/cli/bin/test-orchestrator.js author https://example.com/ -p 3 -n 3
```

Explores up to `-p` pages and asks for `-n` scenarios each. Accepted cases are
written to `<dir>/authored/`; rejected ones are never written and come back with
the reason they failed validation.

The rejection path is not decorative. On a real run the model produced a step
using `expectUrl` before that action existed, and both scenarios containing it
were dropped rather than written as tests that could never run.

### Combination matrix

For a listing or search page, ask for the axes instead:

```bash
node packages/cli/bin/test-orchestrator.js matrix https://example.com/products -l 500
node packages/cli/bin/test-orchestrator.js run -t matrix -j 4
node packages/cli/bin/test-orchestrator.js export -t matrix -o test-cases.csv
```

Both halves of a plan are grounded in the page that was explored: a filter URL
must appear verbatim in the page's own link list, and the result selector must be
one of the selectors observed repeating on it. Invented ones are dropped with a
reason.

Measured on a real e-commerce listing page: **500 distinct cases from one model
call in 2m14s**.

## ▶️ Running

```bash
node packages/cli/bin/test-orchestrator.js run -t cases -j 4 --reporter junit --out results.xml
```

Concurrency is per test case; steps within a case stay ordered. Each lane builds
its runners once and reuses them, so `-j 4` launches four browsers, not one per
test. Measured on 24 browser tests: **10.2s at `-j 1`, 3.2s at `-j 4`**, same
results.

`executeRun` refuses `concurrency > 1` without a `createRunners` factory rather
than silently sharing one runner: the browser runner owns a single page, and two
tests driving one page fail in ways that are very hard to read.

Results keep the order the tests were declared in, whichever lane finished first
— including in the JSON and JUnit reports.

## 🔍 Triage

A failing suite is a pile of error strings until someone decides what each one
means.

```bash
node packages/cli/bin/test-orchestrator.js triage -i results.json -t authored
```

| Verdict       | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `product-bug` | the application is broken; open a ticket             |
| `test-bug`    | the test is wrong: bad selector, expectation or flow |
| `flaky`       | timing or a race; a rerun could pass                 |
| `environment` | blocked, throttled or unreachable                    |
| `test-data`   | credentials, ids or fixtures that do not exist       |

Rules go first, and they are not a shortcut: a 403, a 5xx, a DNS failure or a
step that only passed on retry has one correct reading, and a regex gives it in
microseconds. Measured on a blocked run: **8 failures triaged in 0.22s with zero
model calls** — the same eight through a local model would have cost about four
minutes.

What needs judgement goes to the model with two things attached that decide the
verdict:

**The rest of the run.** Asked about a failed login in isolation, the model
called it a product bug. Shown that "log in with invalid credentials" had passed
in the same run — proving the login flow works — it called the same failure
`test-data` and named the invented credentials.

**What the page showed.** The runner records that `.welcome-message` matched
**0** elements, that the page does contain `.error-message`, and that its text is
_"Invalid email or password."_ The verdict stops being inferred from how the
credentials look and becomes a statement about what the page said.

Artifacts land under the workspace's `.artifacts/<test-case-id>/`:

```
.artifacts/login-with-remember-me/step-7.png    the screenshot
.artifacts/login-with-remember-me/step-7.json   the facts, also carried in the report
```

The raw DOM is deliberately not captured: far too large for a model, and almost
none of it bears on the failure.

A model that is slow, unreachable or off-contract yields a low-confidence result
rather than an exception. Triage must never break the run that produced the
failure.

## 🔧 Self-healing, and what that must not mean

A suite that heals itself by weakening its assertions is worse than one that
stays red: it turns a broken application green. So `repair` is deliberately
narrow.

```bash
node packages/cli/bin/test-orchestrator.js repair -i results.json -t authored
node packages/cli/bin/test-orchestrator.js repair -i results.json -t authored --apply
```

- It acts **only** on a high-confidence `test-bug`. `product-bug` would hide a
  real defect, `environment` would pretend a blocked run succeeded, and
  `test-data` would mean inventing credentials — which it never does.
- The **only** edit available is repointing one step at a different selector, and
  the replacement must be one the runner _observed on the page_. It cannot delete
  a step, lower an expected count, accept a different status or rewrite an
  expected string.
- `repairIsSafe` re-checks the produced test case against the original, so a bug
  in the repair code cannot weaken a suite either.
- Every repair is **verified by re-running the test**. Nothing is written unless
  the change actually fixes it, and nothing at all without `--apply`.

The dangerous case is worth being concrete about. Two demoshop tests fail looking
for `.welcome-message` while the page really does contain `.error-message` — a
naive healer would repoint them and turn a failing login into a passing test.
Triage calls those `test-data`, so no repair is offered. When the same selector
is stale for the right reason — `examples/demoshop/repair`, where the app renamed
it to `.welcome-banner` and login genuinely works — the repair is proposed,
verified and applied.

## 🔌 MCP server

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

| Tool              | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `list_tests`      | list discovered `*.test-case.json` files                  |
| `run_tests`       | run a directory of test cases, return a pass/fail summary |
| `generate_tests`  | scaffold schema-compliant test-case templates             |
| `test_url`        | comprehensive browser UI audit of a single URL            |
| `explore_site`    | crawl a site and generate tests from what is found        |
| `author_tests`    | LLM-written scenarios, validated before they are kept     |
| `triage_failures` | run a suite and classify every failure                    |
| `ingest_project`  | adopt an existing test suite                              |

`matrix` and `repair` are CLI-only: one is long-running, the other writes to your
test files, and neither belongs behind a tool call an agent can make casually.

## 🖥️ Web dashboard

```bash
# from a directory containing test-orchestrator.config.json + *.test-case.json
PORT=4600 node packages/web/dist/server.js   # open http://localhost:4600
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

`*.test-case.json`:

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
  "id": "search-dresses",
  "version": "1.0",
  "name": "Search returns results",
  "runner": "ui",
  "steps": [
    { "action": "goto", "value": "https://example.com/products" },
    { "action": "expectStatus", "value": 200 },
    { "action": "fill", "target": "#search", "value": "dress" },
    { "action": "press", "target": "#search", "value": "Enter" },
    { "action": "expectUrl", "value": "search=dress" },
    { "action": "expectMinCount", "target": ".product-card", "value": 1 },
    { "action": "expectNoConsoleErrors" }
  ]
}
```

## ⚠️ Limits worth knowing

- **Sites behind bot protection.** A real target's home and category pages may
  serve normally while its search endpoint returns 403 to automation. Tests
  generate fine and are perfectly valid; they simply cannot be executed against
  that host. This project does not attempt to defeat bot protection.
- **The author has no test data.** It will write a login flow with plausible
  invented credentials, which then fails. Triage correctly calls that
  `test-data`, but supplying real fixtures is still on you.
- **A local 14B model is slow.** Budget tens of seconds per call. This is why
  triage runs rules first and why the matrix asks for axes rather than cases.

## 🛠️ Development

```bash
pnpm build        # tsc -b across all packages (turbo)
pnpm test         # vitest across all packages
pnpm lint         # eslint, typed rules, zero warnings
pnpm check-types  # type-check only
```

CI builds, lints, tests and runs a CLI end-to-end smoke on every push and pull
request.

## 📄 License

MIT
