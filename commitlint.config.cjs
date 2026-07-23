module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'chore',
        'ci',
        'build',
        'revert',
      ],
    ],
    // One scope per workspace package, plus the cross-cutting ones.
    'scope-enum': [
      2,
      'always',
      [
        'schema',
        'core',
        'cli',
        'web',
        'browser',
        'agent',
        'mcp',
        'config',
        'deps',
        // repo-wide: README, CI, tooling that belongs to no single package
        'repo',
        'release',
      ],
    ],
    'scope-empty': [2, 'never'],
    'subject-case': [2, 'always', 'lower-case'],
  },
};
