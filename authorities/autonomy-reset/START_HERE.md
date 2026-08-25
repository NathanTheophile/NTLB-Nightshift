# NIGHTSHIFT — AUTONOMY RESET
**Date:** 2026-08-25  
**Repository:** `NathanTheophile/NTLB-Nightshift`  
**Audited base:** `dev@5f49e0b077d495f2e3cd7202ed29dfdfe06a7893`

## Purpose

This pack recenters NightShift on its original product objective:

> A user queues work, leaves it running unattended, and a Delegated Leader can inspect each implementation attempt, react to validation/evidence, issue corrective work automatically, and stop only when the task is genuinely done or safely blocked.

This is a **functional architecture reset**, not a repository rewrite.

The existing Electron/FCC/Git/SQLite execution infrastructure is retained where useful. The human-driven `Publish Candidate → Follow-up → inspect → Follow-up again` loop is **not** the autonomous architecture.

## Authority precedence

For the Delegated Leader / autonomous Planner path, this pack supersedes conflicting semantics in the current repository authority, especially:

- `authorities/01_PRODUCT_VISION_AND_SCOPE.md` — automation loop;
- `authorities/05_RUNTIME_ARCHITECTURE.md` — interpretation of orchestration;
- `authorities/07_PLANNER_AND_RUNS.md` — Run/attempt/retry semantics;
- `authorities/10_GIT_ISOLATION_AND_SAFETY.md` — candidate/checkpoint semantics.

Everything unrelated to the autonomous Planner remains governed by the existing authority pack.

## Read order

1. `00_AUTONOMOUS_MASTER_AUTHORITY.md`
2. `01_LUNA_LEADER_PROTOCOL.md`
3. `02_RUN_AND_ATTEMPT_MODEL.md`
4. `03_REUSE_REFACTOR_DEPRECATE.md`
5. `04_IMPLEMENTATION_SEQUENCE.md`
6. `05_ACCEPTANCE_TESTS.md`
7. `06_CODEX_IMPLEMENTATION_PROMPT.md`
8. `07_DECISIONS_LOCKED.md`

## Immediate product freeze

Until the autonomous acceptance test passes:

- no Sequential Batch redesign;
- no Runs cosmetic redesign;
- no worktree naming work;
- no extra Planner UX;
- no manual Follow-up feature work;
- no further Review/Integration expansion;
- no new provider/agent breadth unless required by Delegated Leader.

The current `Single Agent`, `Sequential Batch`, manual `Follow-up`, and manual `Publish Candidate` features may remain in the repository for compatibility, but they are **not the target architecture**.

## Hard success criterion

NightShift is not considered back on target until this works:

```text
User queues one Delegated Leader Task
→ user does nothing else
→ Luna Leader issues work
→ Worker edits in isolated worktree
→ deterministic validation runs
→ Leader receives implementation + validation evidence
→ Leader decides DONE / FIX / BLOCKED
→ if FIX, NightShift launches another fresh Worker attempt automatically
→ repeats without human input
→ terminal outcome is either:
   - COMPLETED: validation passed and Leader accepted implementation
   - BLOCKED: bounded autonomous attempts exhausted or unrecoverable condition
```

No intermediate remote push and no human-written Follow-up are required for the correction loop.
