import { createServer, type Server } from 'node:http';

import { executeRun, createRunnerRegistry } from '@test-orchestrator/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrowserRunner } from '../src/browser-runner.js';
import { exploreSite, generateTestsFromExploration, sampleValue } from '../src/explorer.js';

import type { RunOptions } from '@test-orchestrator/core';
import type { AddressInfo } from 'node:net';

let server: Server;
let baseUrl: string;
const submissions: string[] = [];

const HOME = `<html lang="en"><head><title>Home</title><meta name="description" content="demo home"></head>
<body><h1>Welcome</h1>
<a href="/about">About</a> <a href="/contact">Contact</a>
<form action="/search" method="get"><label>Search <input name="q" type="search" /></label><button type="submit">Go</button></form>
</body></html>`;

const ABOUT = `<html lang="en"><head><title>About</title><meta name="description" content="about us"></head>
<body><h1>About</h1><a href="/">Home</a></body></html>`;

const CONTACT = `<html lang="en"><head><title>Contact</title><meta name="description" content="contact us"></head>
<body><h1>Contact</h1>
<form action="/contact" method="post">
  <label>Name <input name="fullname" type="text" required /></label>
  <label>Email <input name="email" type="email" required /></label>
  <label>Message <textarea name="message"></textarea></label>
  <label><input name="subscribe" type="checkbox" /> Subscribe</label>
  <button type="submit">Send</button>
</form>
<a href="/">Home</a></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'POST') {
        submissions.push(body);
      }
      const html = path === '/about' ? ABOUT : path === '/contact' ? CONTACT : HOME;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sampleValue', () => {
  it('picks plausible values from the field type and name', () => {
    expect(sampleValue('email', 'x')).toBe('test@example.com');
    expect(sampleValue('password', 'x')).toBe('Test1234!');
    expect(sampleValue('number', 'x')).toBe('42');
    expect(sampleValue('text', 'userEmail')).toBe('test@example.com');
    expect(sampleValue('text', 'nickname')).toBe('test');
  });
});

describe('exploreSite', () => {
  it('crawls same-origin pages and records links, headings and forms', async () => {
    const map = await exploreSite(baseUrl, { maxPages: 3 });

    expect(map.pages.length).toBeGreaterThanOrEqual(2);
    const home = map.pages[0];
    expect(home?.title).toBe('Home');
    expect(home?.headings).toContain('Welcome');
    expect(home?.links.some((l) => l.endsWith('/contact'))).toBe(true);

    const contact = map.pages.find((p) => p.url.endsWith('/contact'));
    expect(contact).toBeDefined();
    const form = contact?.forms[0];
    expect(form?.method).toBe('post');
    expect(form?.hasSubmit).toBe(true);
    expect(form?.fields.map((f) => f.name).sort()).toEqual([
      'email',
      'fullname',
      'message',
      'subscribe',
    ]);
    expect(form?.fields.find((f) => f.name === 'email')?.required).toBe(true);
  }, 60000);
});

describe('generateTestsFromExploration', () => {
  it('authors an audit per page, a flow per form, and a navigation check', async () => {
    const map = await exploreSite(baseUrl, { maxPages: 3 });
    const cases = generateTestsFromExploration(map);

    const parsed = cases.map(
      (c) => JSON.parse(c.content) as { id: string; name: string; steps: { action: string }[] },
    );
    expect(parsed.some((p) => p.id.startsWith('audit-'))).toBe(true);
    expect(parsed.some((p) => p.id === 'navigation')).toBe(true);

    const formCase = parsed.find((p) => p.id.startsWith('form-'));
    expect(formCase).toBeDefined();
    const actions = formCase?.steps.map((s) => s.action) ?? [];
    expect(actions).toContain('fill');
    expect(actions).toContain('click');
    expect(actions.at(-1)).toBe('expectNoConsoleErrors');
  }, 60000);

  it('the generated tests actually pass when run against the site', async () => {
    const map = await exploreSite(baseUrl, { maxPages: 2 });
    const cases = generateTestsFromExploration(map, 'ui');
    const testCases = cases.map((c) => JSON.parse(c.content) as unknown);

    const runners = createRunnerRegistry();
    runners.register(createBrowserRunner('ui'));
    const summary = await executeRun({
      config: {
        version: '1.0',
        name: 'explored',
        runners: [{ name: 'ui', type: 'browser' }],
      } as unknown as RunOptions['config'],
      testCases: testCases as unknown as RunOptions['testCases'],
      runners,
    });

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.failed).toBe(0);
  }, 120000);
});

describe('the model-free suite', () => {
  it('audits, checks accessibility and watches the network on every page', () => {
    const map = {
      origin: 'https://shop.test',
      startUrl: 'https://shop.test/',
      pages: [
        {
          url: 'https://shop.test/',
          title: 'Home',
          status: 200,
          links: [],
          headings: ['Home'],
          repeated: [],
          forms: [],
        },
      ],
    };
    const [audit] = generateTestsFromExploration(map);
    const parsed = JSON.parse(audit?.content ?? '{}') as { steps: { action: string }[] };
    // this is the half of the product that runs with no model and no key
    expect(parsed.steps.map((s) => s.action)).toEqual([
      'goto',
      'expectStatus',
      'audit',
      'expectNoFailedRequests',
      'expectA11y',
    ]);
  });
});
