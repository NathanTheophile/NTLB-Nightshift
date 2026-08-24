# 07 — Planner and Runs

## 1. Planner role

Planner is the automation intent queue.

It answers:

> What should NightShift attempt next?

Planner is not a chat and not a terminal.

## 2. Task creation

Required fields:

```text
Prompt
Agent: Agent | Auto
Model: Model | Auto
Priority: integer, 1 highest
```

Optional/future:
- title override;
- timeout;
- validation profile;
- tags.

## 3. Auto resolution

V1:

```text
Agent Auto → configured default agent
Model Auto → configured default model compatible with resolved agent
```

No intelligent classifier/routing in V1.

Resolved values are persisted on the Run even if Task remains `Auto`.

## 4. Scheduling

V1 top-level scheduler:

```text
select queued Task
ORDER BY priority ASC, createdAt ASC
LIMIT 1
```

Only one top-level Planner Run may execute at a time.

The coding agent itself may use internal subagents/concurrency.

## 5. Task lifecycle

Suggested:

```text
queued
  ↓
running
  ├→ completed
  ├→ failed
  ├→ blocked
  └→ cancelled
```

Task status should remain understandable even when multiple Runs exist.

## 6. Run creation

Each attempt creates a fresh Run.

```text
Task #12
  ├ Run #41 — failed
  └ Run #42 — completed
```

Never overwrite Run #41 with retry output.

## 7. Git requirement

Write-capable Planner Runs require a Git Workspace in V1.

Run preparation:
1. resolve Workspace;
2. record repository HEAD/base state;
3. create isolated NightShift worktree;
4. launch agent in worktree;
5. preserve result until review/cleanup policy applies.

If Workspace is not Git:
- read-only automation may be possible later;
- write-capable Run must refuse with a clear capability error.

## 8. Dirty main workspace

Planner Run isolation means user's dirty main workspace does not become the agent's write target.

The exact base-selection policy when main workspace is dirty is still a technical decision:
- current HEAD;
- selected branch commit;
- dedicated clean mirror.

The Run must always record exact base SHA.

## 9. Run state machine

Recommended:

```text
created
  ↓
preparing
  ├─ resolve agent/model
  ├─ validate FCC
  ├─ validate agent capability
  └─ create worktree
  ↓
running
  ├→ completed
  ├→ failed
  ├→ blocked
  ├→ timed_out
  └→ cancellation flow
```

## 10. Completion

A completed process exit is not automatically a successful software change.

Run record distinguishes:
- process exit;
- agent-reported result;
- NightShift validation;
- Git diff/candidate state.

Initial vertical slice may use a simpler success definition, but schema should not collapse these concepts.

## 11. Planner display

Current mockup authority:
- rows remain visible after completion;
- completed row can be archived using `×`;
- archive hides from Planner only;
- Run remains in Runs/history.

## 12. Click behavior

Clicking a Task opens:
- latest/current Run;
- or Task detail with Run attempts if multiple.

## 13. Cancellation

User can request cancel for running Run.

NightShift:
- marks `cancel_requested`;
- asks adapter/process supervisor to terminate safely;
- kills owned process tree if required;
- records final state.

It does not delete the worktree automatically before evidence is persisted.

## 14. Timeout

Hard runtime limits are required before unattended overnight use.

Timeout should be per Run or default profile.

On timeout:
- terminate owned agent process tree;
- preserve logs/worktree;
- mark `timed_out`;
- advance Planner according to policy.

## 15. Queue resilience

One failed Task must not freeze the entire night.

Default future unattended behavior:
- terminal failure state;
- continue to next queued Task.

Retries must be explicit/configurable, not infinite loops.

## 16. Priority changes

Queued Tasks may be reprioritized.

Running Run is not preempted by a newly-added higher-priority Task in V1.

## 17. Validation

Validation profiles are future-facing:
- none;
- agent-selected;
- project default;
- explicit commands.

All validation evidence should be attached to Run, not Task.
