export type TestStatus = 'pass' | 'fail' | 'flaky';

export interface Step {
  id?: string;
  action: string;
  args?: unknown[];
  target?: string;
  value?: unknown;
  description?: string;
  timeout?: number;
  retry?: number;
}

export interface ExpectedError {
  code: string;
  message: string;
}

export interface Expected {
  status?: TestStatus;
  error?: ExpectedError;
  assertion?: Record<string, unknown>;
}

export interface TestCase {
  id: string;
  version: '1.0';
  name: string;
  description?: string;
  tags?: string[];
  runner?: string;
  steps: Step[];
  expected?: Expected;
  timeout?: number;
  retry?: number;
  metadata?: Record<string, unknown>;
}
