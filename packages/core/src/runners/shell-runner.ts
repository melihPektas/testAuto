import { spawn } from 'node:child_process';

import type { Runner, RunContext, StepResult } from '../types.js';

export function createShellRunner(name?: string): Runner {
  return {
    kind: 'runner',
    name: name ?? 'shell',
    type: 'shell',
    runStep: (ctx: RunContext): Promise<StepResult> => {
      const start = Date.now();
      return new Promise<StepResult>((resolve) => {
        const command = ctx.step?.action;

        if (!command) {
          return resolve({
            status: 'fail',
            durationMs: 0,
            error: {
              message: 'no action to run',
              code: 'ORCH_STEP_FAILED',
            },
          });
        }

        const process = spawn(command, { shell: true, signal: ctx.signal });
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        process.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        process.on('close', (code) => {
          const durationMs = Date.now() - start;

          if (code === 0) {
            resolve({
              status: 'pass',
              durationMs,
              output: stdout,
            });
          } else {
            resolve({
              status: 'fail',
              durationMs,
              output: stdout,
              error: {
                message: stderr || `exited with code ${String(code)}`,
                code: 'ORCH_STEP_FAILED',
              },
            });
          }
        });

        process.on('error', (err) => {
          const durationMs = Date.now() - start;
          resolve({
            status: 'fail',
            durationMs,
            error: {
              message: err.message,
              code: 'ORCH_STEP_FAILED',
            },
          });
        });
      });
    },
  };
}
