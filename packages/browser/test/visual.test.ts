import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunnerRegistry, executeRun } from '@test-orchestrator/core';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrowserRunner } from '../src/browser-runner.js';
import { compareScreenshots } from '../src/visual.js';

import type { RunOptions, StepResult } from '@test-orchestrator/core';
import type { AddressInfo } from 'node:net';

/** A solid-colour PNG, for exercising the comparison without a browser. */
function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A PNG that is `rgb` except for a filled rectangle of `spot`. */
function withSpot(
  width: number,
  height: number,
  rgb: [number, number, number],
  spot: [number, number, number],
  area: { x: number; y: number; w: number; h: number },
): Buffer {
  const png = PNG.sync.read(solid(width, height, rgb));
  for (let y = area.y; y < area.y + area.h; y += 1) {
    for (let x = area.x; x < area.x + area.w; x += 1) {
      const i = (y * width + x) * 4;
      png.data[i] = spot[0];
      png.data[i + 1] = spot[1];
      png.data[i + 2] = spot[2];
    }
  }
  return PNG.sync.write(png);
}

describe('compareScreenshots', () => {
  it('reports zero difference for identical images', () => {
    const img = solid(40, 40, [255, 255, 255]);
    const result = compareScreenshots(img, img);
    expect(result.ratio).toBe(0);
    expect(result.diffPixels).toBe(0);
    expect(result.sizeMismatch).toBe(false);
  });

  it('measures the changed fraction', () => {
    const base = solid(100, 100, [255, 255, 255]);
    // a 10x10 red spot is 100 of 10000 pixels = 1%
    const changed = withSpot(100, 100, [255, 255, 255], [255, 0, 0], { x: 0, y: 0, w: 10, h: 10 });
    const result = compareScreenshots(changed, base);
    expect(result.diffPixels).toBe(100);
    expect(result.ratio).toBeCloseTo(0.01, 5);
    expect(result.diff).toBeInstanceOf(Buffer);
  });

  it('reports a size change rather than a meaningless ratio', () => {
    const result = compareScreenshots(solid(50, 60, [0, 0, 0]), solid(40, 40, [0, 0, 0]));
    expect(result.sizeMismatch).toBe(true);
    expect(result.width).toBe(50);
    expect(result.diff).toBeUndefined();
  });
});

describe('expectScreenshot against a real page', () => {
  let server: Server;
  let baseUrl: string;
  let workspace: string;
  let heading = 'Hello';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><body style="margin:0"><h1 style="font-family:monospace">${heading}</h1></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    workspace = await mkdtemp(join(tmpdir(), 'visual-'));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  });

  async function shotStep(): Promise<StepResult> {
    const runners = createRunnerRegistry();
    runners.register(createBrowserRunner('ui'));
    const summary = await executeRun({
      config: {
        version: '1.0',
        name: 'visual',
        runners: [{ name: 'ui', type: 'browser' }],
      } as unknown as RunOptions['config'],
      testCases: [
        {
          id: 'home',
          version: '1.0',
          name: 'visual',
          runner: 'ui',
          steps: [
            { id: 'goto', action: 'goto', value: baseUrl },
            { id: 'shot', action: 'expectScreenshot', value: 0.001 },
          ],
        },
      ] as unknown as RunOptions['testCases'],
      runners,
      workspace: {
        root: workspace,
        artifacts: join(workspace, '.artifacts'),
        temp: workspace,
        resolve: (p: string) => join(workspace, p),
      },
    });
    return summary.results[0]?.steps.find((s) => s.stepId === 'shot') as StepResult;
  }

  it('creates a baseline on the first run and passes, saying so', async () => {
    const step = await shotStep();
    expect(step.status).toBe('pass');
    expect(step.output).toContain('baseline created');
    // the baseline really is on disk
    await expect(
      readFile(join(workspace, '.baselines', 'home', 'shot.png')),
    ).resolves.toBeInstanceOf(Buffer);
  }, 60_000);

  it('passes on the second run when nothing changed', async () => {
    const step = await shotStep();
    expect(step.status).toBe('pass');
    expect(step.output).toContain('matches baseline');
  }, 60_000);

  it('fails when the page changed, and writes a diff', async () => {
    heading = 'Completely different heading now';
    const step = await shotStep();
    expect(step.status).toBe('fail');
    expect(step.error?.message).toContain('pixels changed');
    await expect(
      readFile(join(workspace, '.artifacts', 'home', 'shot-diff.png')),
    ).resolves.toBeInstanceOf(Buffer);
  }, 60_000);
});
