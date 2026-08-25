# 02 — RUN AND ATTEMPT MODEL

## 1. Preserve legacy Runs, add autonomous attempts

For `execution_mode = delegated_leader`, define:

```text
Planner Task
  └ Autonomous Run
      ├ Leader decision
      ├ Worker Attempt 0
      ├ validation
      ├ Leader decision
      ├ Worker Attempt 1
      ├ validation
      └ ...
```

Single Agent and Sequential Batch may keep existing behavior temporarily.

## 2. Migration

Add one migration after the current schema.

Recommended table:

```sql
CREATE TABLE run_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  worker_agent_id TEXT NOT NULL,
  worker_model_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
  ),
  external_session_id TEXT,
  result_summary TEXT,
  failure_reason TEXT,
  validation_status TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, attempt_index)
);

CREATE INDEX run_attempts_run_idx
ON run_attempts(run_id, attempt_index);
```

Add Run-level fields if needed for deterministic restart/UI:

```sql
ALTER TABLE runs ADD COLUMN leader_model_id TEXT;
ALTER TABLE runs ADD COLUMN max_attempts INTEGER;
ALTER TABLE runs ADD COLUMN autonomy_phase TEXT;
```

Recommended `autonomy_phase` values:

```text
planning
worker
validation
evaluating
terminal
```

Do not add an oversized workflow engine.

## 3. Events

Reuse `run_events` for ordered orchestration evidence.

Add event types such as:

```text
leader_resolution
leader_request
leader_decision
leader_protocol_error
attempt_created
attempt_started
attempt_completed
attempt_failed
attempt_validation_started
attempt_validation_completed
autonomous_completed
autonomous_blocked
```

Raw FCC Leader responses may be persisted as bounded protocol evidence, but the user-facing summary comes from validated `LeaderDecision.summary`.

## 4. Validation ownership

Preferred durable fix:

```sql
ALTER TABLE run_validation_commands
ADD COLUMN attempt_id TEXT REFERENCES run_attempts(id) ON DELETE RESTRICT;
```

Every validation command executed during a Delegated Leader attempt references that attempt. Legacy rows may keep `attempt_id = NULL`.

## 5. Worktree lifecycle

Exactly one isolated worktree per autonomous Run.

Between attempts:

```text
do not remove worktree
do not create another worktree
do not push intermediate branch
do not require intermediate commit
```

The next Worker sees the current filesystem state left by the previous attempt.

## 6. Worker invocation

Every attempt is a fresh external coding-agent invocation. Do not rely on resuming the previous Worker conversation.

The worktree is the durable shared state.

## 7. Overall timeout

The current hard Run timeout becomes the **whole autonomous mission deadline**.

Leader calls, Worker attempts, and validation all consume the same deadline. No attempt resets the clock.

## 8. Cancellation

Cancellation applies to the entire autonomous Run.

If cancellation occurs:

- abort active Leader HTTP request;
- or cancel active Worker process tree;
- or cancel active validation process tree;
- create no future attempt;
- persist current Git/evidence;
- terminate Run as `cancelled`.

## 9. Restart recovery

First vertical slice:

- preserve worktree and all attempt/evidence records;
- delegated Run found active after restart becomes `blocked`;
- do not guess which action was in flight;
- do not blind-resume V1 orchestration.

## 10. Candidate lifecycle

Only a terminal autonomous `completed` Run is eligible for existing Candidate publication.

Existing `publishCandidate()` may remain manual. It publishes the final worktree state after all autonomous corrections.

## 11. Manual Follow-up

Existing manual Follow-up stays legacy/recovery functionality.

Delegated Leader does not call `createFollowUp()` and does not require `source_run_id`.

Autonomous correction is represented by `run_attempts`, not nested Runs.
