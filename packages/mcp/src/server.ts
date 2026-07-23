import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  exploreSiteTool,
  generateTests,
  ingestProjectTool,
  listTests,
  runTests,
  testUrl,
} from './tools.js';

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build the test-orchestrator MCP server, exposing the orchestrator's core
 * capabilities as tools an MCP client (e.g. Claude) can call.
 *
 * @public
 */
export function createOrchestratorServer(): McpServer {
  const server = new McpServer({ name: 'test-orchestrator', version: '0.0.1' });

  server.tool(
    'list_tests',
    'List *.test-case.json files discovered in a directory.',
    { dir: z.string().default('.') },
    async ({ dir }) => textResult({ dir, files: await listTests(dir) }),
  );

  server.tool(
    'run_tests',
    'Run every test case in a directory through the orchestrator and return a pass/fail summary.',
    {
      configPath: z.string().default('test-orchestrator.config.json'),
      testsDir: z.string().default('.'),
    },
    async ({ configPath, testsDir }) => textResult(await runTests(configPath, testsDir)),
  );

  server.tool(
    'generate_tests',
    'Generate schema-compliant test-case template files for the given names.',
    { names: z.array(z.string()).default(['sample']), dir: z.string().default('.') },
    async ({ names, dir }) => textResult(await generateTests(names, dir)),
  );

  server.tool(
    'test_url',
    'Run a comprehensive UI audit against a URL with a real browser: navigate, assert a 2xx status, then check title, rendered body, console errors, broken images, link count, meta description, and mobile responsiveness. Returns a pass/fail summary with per-check findings.',
    { url: z.string().url() },
    async ({ url }) => textResult(await testUrl(url)),
  );

  server.tool(
    'explore_site',
    'Explore a website with a real browser and AUTHOR test cases from what is found: crawls same-origin pages, records links, headings and every form with its fields, then writes an orchestrator test case per page (UI audit), per form (fill-and-submit flow) and a navigation check into <dir>/explored/. This is how the agent writes tests for an app it has never seen.',
    { url: z.string().url(), maxPages: z.number().int().min(1).max(20).default(5), dir: z.string().default('.') },
    async ({ url, maxPages, dir }) => textResult(await exploreSiteTool(url, maxPages, dir)),
  );

  server.tool(
    'ingest_project',
    'Evaluate a project directory: detect its test framework (vitest/jest/playwright/mocha), discover existing test files, and ingest them as orchestrator test cases written to <dir>/ingested/. Returns the framework, discovered files, and what was written.',
    { dir: z.string().default('.') },
    async ({ dir }) => textResult(await ingestProjectTool(dir)),
  );

  return server;
}

/**
 * Start the MCP server over stdio (the transport MCP clients launch it with).
 *
 * @public
 */
export async function startStdioServer(): Promise<void> {
  const server = createOrchestratorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
