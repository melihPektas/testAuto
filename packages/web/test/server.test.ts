import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDashboardServer } from '../src/server.js';

import type { AddressInfo } from 'node:net';

let server: ReturnType<typeof createDashboardServer>;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'to-web-'));
  await writeFile(
    join(dir, 'test-orchestrator.config.json'),
    JSON.stringify({ version: '1.0', name: 'web-suite', runners: [{ name: 'default', type: 'shell' }] }),
    'utf8',
  );
  await writeFile(
    join(dir, 'ok.test-case.json'),
    JSON.stringify({ id: 'ok', version: '1.0', name: 'ok', runner: 'default', steps: [{ action: 'exit 0' }] }),
    'utf8',
  );

  server = createDashboardServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('dashboard server', () => {
  it('reports health', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('lists test-case files', async () => {
    const res = await fetch(`${baseUrl}/api/tests?dir=${encodeURIComponent(dir)}`);
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toContain('ok.test-case.json');
  });

  it('runs the suite and returns a summary', async () => {
    const res = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configPath: join(dir, 'test-orchestrator.config.json'),
        testsDir: dir,
      }),
    });
    const summary = (await res.json()) as { status: string; total: number; passed: number };
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.status).toBe('pass');
  });

  it('exposes the configured runners via /api/config', async () => {
    const res = await fetch(
      `${baseUrl}/api/config?path=${encodeURIComponent(join(dir, 'test-orchestrator.config.json'))}`,
    );
    const body = (await res.json()) as { name: string; runners: { name: string; type: string }[] };
    expect(body.name).toBe('web-suite');
    expect(body.runners).toEqual([{ name: 'default', type: 'shell' }]);
  });

  it('reads a test case for the editor', async () => {
    const res = await fetch(
      `${baseUrl}/api/testcase?dir=${encodeURIComponent(dir)}&file=ok.test-case.json`,
    );
    const body = (await res.json()) as { file: string; content: string };
    expect(body.file).toBe('ok.test-case.json');
    expect(JSON.parse(body.content)).toMatchObject({ id: 'ok' });
  });

  it('saves an edited test case after validating it', async () => {
    const edited = JSON.stringify({
      id: 'ok',
      version: '1.0',
      name: 'renamed by editor',
      runner: 'default',
      steps: [{ action: 'exit 0' }],
    });
    const res = await fetch(`${baseUrl}/api/testcase`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, file: 'ok.test-case.json', content: edited }),
    });
    expect(res.status).toBe(200);

    const check = await fetch(
      `${baseUrl}/api/testcase?dir=${encodeURIComponent(dir)}&file=ok.test-case.json`,
    );
    const body = (await check.json()) as { content: string };
    expect(JSON.parse(body.content)).toMatchObject({ name: 'renamed by editor' });
  });

  it('rejects malformed JSON and schema-invalid test cases', async () => {
    const bad = await fetch(`${baseUrl}/api/testcase`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir, file: 'ok.test-case.json', content: '{ not json' }),
    });
    expect(bad.status).toBe(400);

    const invalid = await fetch(`${baseUrl}/api/testcase`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dir,
        file: 'ok.test-case.json',
        content: JSON.stringify({ id: 'x', version: '1.0', name: 'no steps', steps: [] }),
      }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: string }).error).toContain('invalid test case');
  });

  it('refuses path traversal and non test-case files', async () => {
    for (const file of ['../secret.json', 'notes.txt', 'sub/dir.test-case.json']) {
      const res = await fetch(
        `${baseUrl}/api/testcase?dir=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it('streams live run progress and a final summary over SSE', async () => {
    const res = await fetch(
      `${baseUrl}/api/run/stream?configPath=${encodeURIComponent(join(dir, 'test-orchestrator.config.json'))}&testsDir=${encodeURIComponent(dir)}`,
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: progress');
    expect(text).toContain('"type":"test:end"');
    expect(text).toContain('event: summary');
  });
});
