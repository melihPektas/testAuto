import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executeRun,
  createRunnerRegistry,
  createShellRunner,
  createN8nRunner,
} from '@test-orchestrator/core';
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

async function handleRun(res: ServerResponse, body: unknown): Promise<void> {
  const input = (body ?? {}) as { configPath?: string; testsDir?: string };
  const configPath = resolve(process.cwd(), input.configPath ?? 'test-orchestrator.config.json');
  const testsDir = resolve(process.cwd(), input.testsDir ?? '.');

  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    name: string;
    runners: { name: string; type: string; options?: Record<string, unknown> }[];
  };

  const files = await listTests(testsDir);
  const testCases: unknown[] = [];
  for (const file of files) {
    testCases.push(JSON.parse(await readFile(join(testsDir, file), 'utf8')));
  }

  const runners = createRunnerRegistry();
  for (const runner of config.runners) {
    if (runner.type === 'n8n') {
      const baseUrl = runner.options?.['baseUrl'];
      if (typeof baseUrl === 'string') {
        runners.register(createN8nRunner(runner.name, { baseUrl }));
      }
    } else {
      runners.register(createShellRunner(runner.name));
    }
  }

  const collector: Reporter = { kind: 'reporter', name: 'web', type: 'web' };

  const summary = await executeRun({
    config: config as unknown as RunOptions['config'],
    testCases: testCases as unknown as RunOptions['testCases'],
    runners,
    reporters: [collector],
  });
  sendJson(res, 200, summary);
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
