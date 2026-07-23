# internal

CLI-local helpers: the logger, the CLI's `OrchestratorError`, and the config
loader.

Config and test-case **types, schemas and validation** are no longer duplicated
here — they come from `@test-orchestrator/schema`, the single source of truth.
`config.ts` re-exports them for convenience.
