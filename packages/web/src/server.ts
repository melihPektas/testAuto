import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRepair,
  authorSite,
  failuresFromReport,
  llmOptionsFor,
  matrixSite,
  proposeRepair,
  repairIsSafe,
  triageFailure,
  triageFailures,
  writeAuthored,
} from '@test-orchestrator/agent';
import { browserRunnerFactory } from '@test-orchestrator/browser';
import { executeRun, buildRunnerRegistry } from '@test-orchestrator/core';
import { formatAjvErrors, validateTestCase } from '@test-orchestrator/schema';

import type { Reporter, RunOptions } from '@test-orchestrator/core';
import type { LlmConfig, TestCase } from '@test-orchestrator/schema';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'not found' });
  }
}

async function listTests(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.test-case.json')).sort();
}

/**
 * Resolve a test-case file inside `dir`, rejecting path traversal and any file
 * that is not a `*.test-case.json`.
 */
function resolveTestCaseFile(dir: string, file: string): string | undefined {
  if (!file.endsWith('.test-case.json') || file.includes('/') || file.includes('\\')) {
    return undefined;
  }
  const target = resolve(dir, file);
  return target.startsWith(resolve(dir)) ? target : undefined;
}

async function handleGetTestCase(res: ServerResponse, dir: string, file: string): Promise<void> {
  const target = resolveTestCaseFile(dir, file);
  if (target === undefined) {
    sendJson(res, 400, { error: 'invalid test-case file name' });
    return;
  }
  try {
    sendJson(res, 200, { file, content: await readFile(target, 'utf8') });
  } catch {
    sendJson(res, 404, { error: 'test case not found' });
  }
}

async function handleSaveTestCase(res: ServerResponse, body: unknown): Promise<void> {
  const input = (body ?? {}) as { dir?: string; file?: string; content?: string };
  const dir = resolve(process.cwd(), input.dir ?? '.');
  const file = input.file ?? '';
  const content = input.content ?? '';

  const target = resolveTestCaseFile(dir, file);
  if (target === undefined) {
    sendJson(res, 400, { error: 'invalid test-case file name' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return;
  }

  const validated = validateTestCase(parsed);
  if (!validated.ok) {
    sendJson(res, 400, { error: `invalid test case: ${formatAjvErrors(validated.errors)}` });
    return;
  }

  await writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  sendJson(res, 200, { ok: true, file });
}

interface WebConfig {
  name: string;
  runners: { name: string; type: string; options?: Record<string, unknown> }[];
  llm?: LlmConfig;
}

interface LoadedInputs {
  config: WebConfig;
  testCases: unknown[];
  runners: ReturnType<typeof buildRunnerRegistry>;
}

function resolvePaths(input: { configPath?: string; testsDir?: string }): {
  configPath: string;
  testsDir: string;
} {
  return {
    configPath: resolve(process.cwd(), input.configPath ?? 'test-orchestrator.config.json'),
    testsDir: resolve(process.cwd(), input.testsDir ?? '.'),
  };
}

async function loadInputs(configPath: string, testsDir: string): Promise<LoadedInputs> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as WebConfig;
  const files = await listTests(testsDir);
  const testCases: unknown[] = [];
  for (const file of files) {
    testCases.push(JSON.parse(await readFile(join(testsDir, file), 'utf8')));
  }
  const runners = buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });
  return { config, testCases, runners };
}

async function handleConfig(res: ServerResponse, configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as WebConfig;
  sendJson(res, 200, {
    name: config.name,
    runners: config.runners.map((r) => ({ name: r.name, type: r.type })),
  });
}

async function handleRun(res: ServerResponse, body: unknown): Promise<void> {
  const { configPath, testsDir } = resolvePaths(body ?? {});
  const { config, testCases, runners } = await loadInputs(configPath, testsDir);
  const summary = await executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: testCases as unknown as RunOptions['testCases'],
    runners,
    reporters: [{ kind: 'reporter', name: 'web', type: 'web' }],
  });
  sendJson(res, 200, summary);
}

/**
 * Serve a failure screenshot. Confined to the workspace's artifacts directory:
 * the path comes from a run report, but a report is a file on disk and this
 * endpoint must not become a way to read the rest of one.
 */
async function handleArtifact(res: ServerResponse, relative: string): Promise<void> {
  const root = resolve(process.cwd(), '.artifacts');
  const target = resolve(root, relative);
  if (!target.startsWith(`${root}/`) || extname(target) !== '.png') {
    sendJson(res, 400, { error: 'invalid artifact path' });
    return;
  }
  try {
    const content = await readFile(target);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'artifact not found' });
  }
}

async function handleRunStream(
  res: ServerResponse,
  configPath: string,
  testsDir: string,
  triage: boolean,
  concurrency: number,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const { config, testCases, runners } = await loadInputs(configPath, testsDir);
    const streamer: Reporter = {
      kind: 'reporter',
      name: 'sse',
      type: 'sse',
      onEvent: (event) => {
        send('progress', event);
      },
    };
    const summary = await executeRun({
      config: config as unknown as RunOptions['config'],
      testCases: testCases as unknown as RunOptions['testCases'],
      runners,
      reporters: [streamer],
      concurrency,
      // Each lane needs its own browser; sharing one page across tests does not
      // fail loudly, it fails confusingly.
      createRunners: () => buildRunnerRegistry(config.runners, { browser: browserRunnerFactory }),
    });
    send('summary', summary);

    if (triage && summary.failed > 0) {
      // Each judged failure costs the model tens of seconds, so verdicts are
      // streamed as they land rather than after the last one.
      const failures = failuresFromReport(
        summary as unknown as Parameters<typeof failuresFromReport>[0],
        (testCases as { id?: unknown; steps?: unknown }[])
          .filter(
            (t): t is { id: string; steps: unknown[] } =>
              typeof t.id === 'string' && Array.isArray(t.steps),
          )
          .map((t) => ({ id: t.id, steps: t.steps })),
      );
      send('triage:start', { count: failures.length });
      const byId = new Map(failures.map((f) => [f.testCaseId, f]));
      // Map each test-case id back to its file so the UI can request a repair.
      const fileById = new Map<string, string>();
      for (const file of await listTests(testsDir)) {
        try {
          const parsed = JSON.parse(await readFile(join(testsDir, file), 'utf8')) as {
            id?: unknown;
          };
          if (typeof parsed.id === 'string') {
            fileById.set(parsed.id, file);
          }
        } catch {
          // a file that will not parse simply has no repair target
        }
      }
      const result = await triageFailures(failures, {
        ...llmOptionsFor('triage', config.llm),
        onTriage: (item) => {
          const failure = byId.get(item.testCaseId);
          send('triage', {
            ...item,
            testCaseName: failure?.testCaseName,
            message: failure?.message,
            evidence: failure?.evidence,
            file: fileById.get(item.testCaseId),
          });
        },
      });
      send('triage:done', {
        byVerdict: result.byVerdict,
        byRule: result.byRule,
        byModel: result.byModel,
      });
    }
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}

/** Open an SSE response and hand back a typed `send`. */
function openStream(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function readLlmConfig(configPath: string): Promise<LlmConfig | undefined> {
  try {
    return (JSON.parse(await readFile(configPath, 'utf8')) as WebConfig).llm;
  } catch {
    return undefined;
  }
}

interface GenerateParams {
  url: string;
  dir: string;
  pages: number;
  count: number;
  limit: number;
  configPath: string;
}

async function handleAuthorStream(res: ServerResponse, p: GenerateParams): Promise<void> {
  const send = openStream(res);
  try {
    send('phase', { phase: 'exploring', url: p.url });
    const llm = llmOptionsFor('author', await readLlmConfig(p.configPath));
    const site = await authorSite(p.url, {
      ...llm,
      maxPages: p.pages,
      count: p.count,
      onPage: (pageUrl, accepted, rejected) => {
        send('page', { url: pageUrl, accepted, rejected });
      },
    });
    const written = await writeAuthored(p.dir, site.cases);
    send('done', {
      model: site.model,
      pagesVisited: site.pagesVisited,
      written,
      cases: site.cases.map((c) => ({ path: c.path, name: c.name, steps: c.steps })),
      rejected: site.rejected,
    });
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}

async function handleMatrixStream(res: ServerResponse, p: GenerateParams): Promise<void> {
  const send = openStream(res);
  try {
    send('phase', { phase: 'exploring', url: p.url });
    const llm = llmOptionsFor('matrix', await readLlmConfig(p.configPath));
    send('phase', { phase: 'planning', url: p.url });
    const result = await matrixSite(p.url, { ...llm, limit: p.limit });
    if (result.plan === undefined) {
      send('error', { message: result.rejected.join('; ') || 'no usable matrix plan' });
      return;
    }
    const written = await writeAuthored(p.dir, result.cases);
    send('done', {
      model: result.model,
      plan: {
        resultSelector: result.plan.resultSelector,
        terms: result.plan.search?.terms.length ?? 0,
        axes: result.plan.filters.map((f) => ({ axis: f.axis, values: f.values.length })),
      },
      written,
      cases: result.cases
        .slice(0, 200)
        .map((c) => ({ path: c.path, name: c.name, steps: c.steps })),
      rejected: result.rejected,
    });
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
}

function generateParams(url: URL): GenerateParams {
  const num = (key: string, fallback: number): number => {
    const parsed = Number.parseInt(url.searchParams.get(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    url: url.searchParams.get('url') ?? '',
    dir: resolve(process.cwd(), url.searchParams.get('dir') ?? '.'),
    pages: num('pages', 3),
    count: num('count', 3),
    limit: num('limit', 500),
    configPath: resolve(
      process.cwd(),
      url.searchParams.get('configPath') ?? 'test-orchestrator.config.json',
    ),
  };
}

/**
 * Propose a repair for one failing test, verify it by re-running, and — only
 * when asked and only when it passes — write it back. This is the CLI `repair`
 * flow behind a button, and it keeps every one of that flow's refusals: it acts
 * on nothing but a high-confidence test-bug, it can only repoint a selector, and
 * it re-runs before it believes itself.
 */
async function handleRepair(res: ServerResponse, body: unknown): Promise<void> {
  const input = (body ?? {}) as {
    dir?: string;
    file?: string;
    configPath?: string;
    apply?: boolean;
  };
  const dir = resolve(process.cwd(), input.dir ?? '.');
  const target = resolveTestCaseFile(dir, input.file ?? '');
  if (target === undefined) {
    sendJson(res, 400, { error: 'invalid test-case file name' });
    return;
  }

  const configPath = resolve(process.cwd(), input.configPath ?? 'test-orchestrator.config.json');
  let config: WebConfig;
  let testCase: TestCase;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as WebConfig;
    const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
    const validated = validateTestCase(parsed);
    if (!validated.ok) {
      sendJson(res, 400, { error: formatAjvErrors(validated.errors) });
      return;
    }
    testCase = validated.data;
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }

  const makeRunners = (): ReturnType<typeof buildRunnerRegistry> =>
    buildRunnerRegistry(config.runners, { browser: browserRunnerFactory });

  // Reproduce the failure so triage and repair see real evidence.
  const before = await executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: [testCase] as RunOptions['testCases'],
    runners: makeRunners(),
  });
  const failures = failuresFromReport(
    before as unknown as Parameters<typeof failuresFromReport>[0],
    [{ id: testCase.id, steps: testCase.steps }],
  );
  if (failures.length === 0) {
    sendJson(res, 200, { repaired: false, reason: 'the test passes as it is' });
    return;
  }

  const llm = llmOptionsFor('triage', config.llm);
  const triage = await triageFailure(failures[0]!, llm);
  const proposal = await proposeRepair(
    testCase,
    failures[0]!,
    triage,
    llmOptionsFor('repair', config.llm),
  );
  if (proposal.repair === undefined) {
    sendJson(res, 200, { repaired: false, verdict: triage.verdict, reason: proposal.declined });
    return;
  }

  const repaired = applyRepair(testCase, proposal.repair);
  const unsafe = repairIsSafe(testCase, repaired, proposal.repair);
  const revalidated = validateTestCase(repaired);
  if (unsafe !== undefined || !revalidated.ok) {
    sendJson(res, 200, {
      repaired: false,
      reason: unsafe ?? formatAjvErrors(revalidated.ok ? [] : revalidated.errors),
    });
    return;
  }

  // A repair is a claim that the test now passes. Check the claim.
  const after = await executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: [repaired] as RunOptions['testCases'],
    runners: makeRunners(),
  });
  if (after.status !== 'pass') {
    sendJson(res, 200, { repaired: false, reason: 'the proposed fix did not make the test pass' });
    return;
  }

  const written = input.apply === true;
  if (written) {
    await writeFile(target, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8');
  }
  sendJson(res, 200, {
    repaired: true,
    written,
    from: proposal.repair.from,
    to: proposal.repair.to,
    rationale: proposal.repair.rationale,
  });
}

export function createDashboardServer(): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/tests') {
          const dir = resolve(process.cwd(), url.searchParams.get('dir') ?? '.');
          sendJson(res, 200, { dir, files: await listTests(dir) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/testcase') {
          const dir = resolve(process.cwd(), url.searchParams.get('dir') ?? '.');
          await handleGetTestCase(res, dir, url.searchParams.get('file') ?? '');
          return;
        }
        if (req.method === 'PUT' && url.pathname === '/api/testcase') {
          await handleSaveTestCase(res, await readBody(req));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/config') {
          const configPath = resolve(
            process.cwd(),
            url.searchParams.get('path') ?? 'test-orchestrator.config.json',
          );
          await handleConfig(res, configPath);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/run/stream') {
          const { configPath, testsDir } = resolvePaths({
            configPath: url.searchParams.get('configPath') ?? undefined,
            testsDir: url.searchParams.get('testsDir') ?? undefined,
          });
          const parallel = Number.parseInt(url.searchParams.get('concurrency') ?? '', 10);
          await handleRunStream(
            res,
            configPath,
            testsDir,
            url.searchParams.get('triage') === '1',
            Number.isFinite(parallel) && parallel > 0 ? parallel : 1,
          );
          return;
        }
        if (
          req.method === 'GET' &&
          (url.pathname === '/api/author/stream' || url.pathname === '/api/matrix/stream')
        ) {
          const params = generateParams(url);
          if (!/^https?:\/\//.test(params.url)) {
            sendJson(res, 400, { error: 'a http(s) url is required' });
            return;
          }
          await (url.pathname === '/api/author/stream'
            ? handleAuthorStream(res, params)
            : handleMatrixStream(res, params));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/artifact') {
          await handleArtifact(res, url.searchParams.get('path') ?? '');
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/repair') {
          await handleRepair(res, await readBody(req));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/run') {
          await handleRun(res, await readBody(req));
          return;
        }
        if (req.method === 'GET') {
          await serveStatic(res, url.pathname);
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
    })();
  });
}

export function startServer(port = 4600): void {
  const server = createDashboardServer();
  server.listen(port, () => {
    process.stdout.write(`test-orchestrator dashboard on http://localhost:${port}\n`);
  });
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('server.js')) {
  const envPort = process.env['PORT'];
  startServer(envPort === undefined ? 4600 : Number(envPort));
}
