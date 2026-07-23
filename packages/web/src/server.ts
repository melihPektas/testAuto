import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserRunnerFactory } from '@test-orchestrator/browser';
import { executeRun, buildRunnerRegistry } from '@test-orchestrator/core';

import type { Reporter, RunOptions } from '@test-orchestrator/core';

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

interface WebConfig {
  name: string;
  runners: { name: string; type: string; options?: Record<string, unknown> }[];
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

async function loadInputs(
  configPath: string,
  testsDir: string,
): Promise<{ config: WebConfig; testCases: unknown[]; runners: ReturnType<typeof buildRunnerRegistry> }> {
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
  const { configPath, testsDir } = resolvePaths((body ?? {}));
  const { config, testCases, runners } = await loadInputs(configPath, testsDir);
  const summary = await executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: testCases as unknown as RunOptions['testCases'],
    runners,
    reporters: [{ kind: 'reporter', name: 'web', type: 'web' }],
  });
  sendJson(res, 200, summary);
}

async function handleRunStream(res: ServerResponse, configPath: string, testsDir: string): Promise<void> {
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
    });
    send('summary', summary);
  } catch (err) {
    send('error', { message: (err as Error).message });
  } finally {
    res.end();
  }
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
          await handleRunStream(res, configPath, testsDir);
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
