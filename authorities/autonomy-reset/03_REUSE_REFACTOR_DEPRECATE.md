# 03 — REUSE / REFACTOR / DEPRECATE MAP

Audited against `dev@5f49e0b077d495f2e3cd7202ed29dfdfe06a7893`.

## KEEP — core infrastructure

### FCC runtime
- `FccRuntimeManager`
- `LocalFccGateway`
- FCC health/start/attach ownership
- FCC model catalog

Extend `LocalFccGateway`; do not replace it.

### Coding harness adapters
- `ClaudeCodeAdapter`
- `CodexAdapter`
- `AgentAdapter`
- validated headless execution
- structured protocol capture

### Process safety
- `WindowsProcessSupervisor`
- deterministic process-tree cancellation
- hard timeouts

### Git isolation
- `GitWorktreeService`
- isolated Planner worktrees
- canonical base SHA logic

For delegated mode, switch only the lifecycle to one worktree per autonomous Run.

### Persistence/evidence
- SQLite migrations/repositories
- `run_events`
- protocol compaction/pagination
- validation evidence
- Run Git evidence

### Validation
- `ProjectValidationService`

This is the primary deterministic feedback signal.

### Review evidence utilities
Reuse bounded Git/diff logic from `RunReviewService` where practical for Leader evidence.

### Candidate delivery
Keep final `publishCandidate()` as a post-completion delivery action. It must not be part of each correction.

## REFACTOR — targeted

### `RunService`

Do **not** add the entire Leader state machine inline.

Preferred structure:

```text
RunService
  ├ existing scheduler / legacy single/batch
  └ DelegatedRunOrchestrator
       ├ LeaderClient
       ├ AgentAdapter Worker invocation
       ├ ProjectValidationService
       ├ evidence builder
       └ RunAttemptRepository
```

### `LocalFccGateway`

Add a narrow model-inference capability for Leader decisions. Do not add a second provider stack.

### validation persistence

Associate delegated validation commands with autonomous attempt IDs.

## KEEP BUT REMOVE FROM CRITICAL PATH

### Manual Follow-up
Useful for user intervention, not autonomous retry.

### Sequential Batch
May remain explicit multi-prompt execution. It is not autonomous planning.

### Review & Integration
Keep for final delivery/integration. Do not expand before autonomous correction works.

### Concurrent top-level Runs
Keep bounded scheduler concurrency. Each delegated Run independently owns its Leader loop.

## DO NOT MERGE CURRENT TASK-DELETION CANDIDATE

The current deletion experiment is dogfood evidence, not the next architectural step.

Resume deletion work only after the Delegated Leader gate passes.

## NO REPOSITORY RESET

Do not revert the repository just to erase premature features.

Preserve useful infrastructure and stop spending time on peripheral paths.
