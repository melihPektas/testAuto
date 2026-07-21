#!/usr/bin/env node
import { runCli } from '../dist/index.js';

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (typeof process !== 'undefined' && typeof process.exit === 'function') {
    process.exit(1);
  }
});
