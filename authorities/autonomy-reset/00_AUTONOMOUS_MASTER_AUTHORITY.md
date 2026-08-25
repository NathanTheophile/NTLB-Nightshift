# 00 — AUTONOMOUS MASTER AUTHORITY

## 1. Product invariant

The primary Planner mode is **Delegated Leader**.

The user provides an objective. NightShift supplies orchestration infrastructure. An external Leader model performs the reasoning required to decide what to do next.

NightShift itself does **not** invent implementation plans or diagnose software errors using handwritten heuristics.

## 2. Required autonomous loop

```text
Task
  ↓
Delegated Leader (Luna through FCC)
  ↓
WORK decision + bounded Worker instruction
  ↓
fresh Worker invocation
  ↓
same isolated Run worktree
  ↓
deterministic validation
  ↓
bounded implementation evidence
  ↓
Delegated Leader evaluates state
  ├─ WORK    → next fresh Worker attempt in same worktree
  ├─ DONE    → allowed only when deterministic validation passed
  └─ BLOCKED → terminal blocked report
```

The Leader is called again after **every Worker attempt**, including attempts whose process exited successfully.

A Worker process saying “done” is not a terminal product decision.

## 3. Leader runtime

Default Leader: **Luna**, routed through the user's already-connected OpenAI/ChatGPT provider in FCC.

Implementation requirements:

- use the FCC local gateway;
- use a model exposed by the FCC routable model catalog;
- persist the exact resolved Leader model ID on the Run;
- no paid direct OpenAI API integration;
- no browser automation;
- no private ChatGPT API;
- no use of the embedded GPT WebContentsView for orchestration.

The exact FCC model ID must be resolved from FCC and persisted. Do not hardcode an invented OpenAI model slug.

## 4. Separation of roles

### Delegated Leader
May:
- understand the original Task;
- inspect bounded evidence supplied by NightShift;
- decide whether implementation is complete;
- issue the next Worker instruction;
- decide that the task is blocked.

Must not:
- write project files directly;
- perform Git mutation;
- run arbitrary shell commands;
- push or merge branches.

### Worker
An external coding harness through an existing validated `AgentAdapter`.

May:
- inspect the repository;
- edit within the isolated Run worktree;
- run the existing allowlisted validation/read-only commands already permitted to Planner coding agents.

### NightShift
Owns:
- scheduling;
- worktree lifecycle;
- process supervision;
- persistence;
- deterministic validation;
- evidence collection;
- timeouts/cancellation;
- attempt limits;
- final candidate lifecycle.

NightShift does not substitute its own coding judgment for the Leader.

## 5. One autonomous Run = one mission

For `delegated_leader`:

- one Planner Task creates one autonomous Run;
- that Run creates one isolated worktree;
- all Worker attempts operate in that same worktree;
- every Worker attempt is a fresh harness invocation/session;
- the Run owns the overall timeout/cancellation boundary;
- the Run ends only at `completed`, `blocked`, `cancelled`, or `timed_out`.

This intentionally differs from the old “one attempt = one Run” retry model.

Legacy Single Agent behavior may keep its current semantics.

## 6. Worker attempts

Default maximum: **4 Worker attempts per autonomous Run**.

The limit must be configurable in code/settings later, but V1 may ship with a safe default.

Attempt flow:

1. persist attempt record before launch;
2. invoke Worker with Leader instruction;
3. persist Worker result/protocol evidence;
4. run deterministic project validation;
5. collect bounded Git/validation evidence;
6. call Leader;
7. persist Leader decision;
8. either terminate or create next attempt.

No infinite retry.

## 7. Completion invariant

A Delegated Leader Run may be marked `completed` only when:

```text
latest deterministic validation == passed
AND
latest valid Leader decision == DONE
```

If the Leader says `DONE` while validation failed, NightShift must **not** complete the Run. It calls the Leader again with the failed validation evidence or treats the decision as invalid and asks for a corrective decision.

If validation passes but the Leader says `WORK`, the Run continues.

## 8. Candidate semantics

Intermediate attempts are **not Candidates**.

There must be no required flow like:

```text
attempt
→ commit
→ push
→ publish candidate
→ follow-up
```

between autonomous corrections.

The isolated worktree itself is the durable correction workspace.

Only after autonomous completion may the existing Candidate mechanism be used as a delivery action.

For the first autonomous vertical slice:

- remote Candidate publication remains explicit/manual;
- integration into `dev` remains explicit/manual;
- no remote branch is required between Worker attempts.

## 9. Legacy features

The following are not deleted immediately:

- Single Agent;
- Sequential Batch;
- manual Follow-up;
- manual Candidate publication;
- existing Review & Integration.

But Delegated Leader must not depend on manual Follow-up or intermediate Candidate publication.

Manual Follow-up becomes a recovery/manual intervention feature, not the autonomous retry primitive.

## 10. Safety

Retain existing safety invariants:

- automated writes only in isolated worktree;
- no force push;
- no destructive reset/clean of unknown user data;
- no unattended merge to protected/shared branches;
- deterministic process-tree cancellation;
- bounded hard timeout;
- persisted evidence before cleanup;
- no hidden provider fallback that changes the selected Leader/Worker policy without recording it.

## 11. Failure classes

Terminal `blocked` is correct when:

- Leader provider/model cannot be resolved;
- FCC Leader call repeatedly violates protocol;
- Worker adapter/model is unavailable;
- max Worker attempts exhausted;
- unrecoverable worktree/Git error;
- validation cannot execute deterministically;
- evidence cannot be collected safely.

A blocked Run must preserve its worktree and evidence.

## 12. Explicitly out of scope for this reset

Do not add during the first implementation:

- autonomous merge to `dev`;
- dynamic multi-agent swarms;
- multiple simultaneous Workers inside one delegated task;
- intelligent model escalation;
- UI polish;
- project-wide semantic retrieval for Leader;
- Sequential Batch redesign;
- new agent adapters.

Those may follow only after the autonomous correction loop is proven.
