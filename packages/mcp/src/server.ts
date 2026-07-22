import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { generateTests, listTests, runTests } from './tools.js';

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
