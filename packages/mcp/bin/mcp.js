#!/usr/bin/env node
import { startStdioServer } from '../dist/server.js';

startStdioServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
