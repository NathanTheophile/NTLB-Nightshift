# 04 — IMPLEMENTATION SEQUENCE

## Goal

Reach the first real unattended self-correction test with the fewest additional implementation passes.

## Pass 1 — Autonomous backend vertical slice

Use one strong external implementation pass on current `dev`.

Recommended implementation model: **Terra, Medium effort**.

Do not dogfood this core refactor through the currently non-autonomous NightShift Planner.

Pass 1 includes:

1. `LeaderDecision` protocol + strict parser.
2. FCC Luna Leader client.
3. FCC Luna model resolution from live catalog.
4. migration + `run_attempts`.
5. attempt-aware validation evidence.
6. `DelegatedRunOrchestrator`.
7. `RunService` integration for existing `delegated_leader` execution mode.
8. same-worktree/fresh-Worker autonomous retry loop.
9. cancellation/overall timeout.
10. restart → safe blocked recovery.
11. unit/integration tests with fake Leader/Worker.
12. no UI redesign.

The existing Planner already exposes Delegated Leader as an execution mode; enable the backend path rather than inventing a new surface.

## Pass 1 exit gate

Do not start Pass 2 unless all repository validation passes and automated tests prove:

```text
attempt 1 fails validation
→ fake Leader returns WORK
→ attempt 2 fixes
→ validation passes
→ fake Leader returns DONE
→ same Run completes
→ same worktree used
→ no intermediate Candidate push
→ no human Follow-up
```

## Pass 2 — only if needed for real Luna dogfood

Minimal runtime/UI correction only.

Possible needs:

- set/display resolved Luna Leader model;
- show `attempt 1/4`, `attempt 2/4`;
- surface Leader summary;
- expose blocked reason.

No visual redesign.

If Pass 1 can resolve Luna automatically and existing UI launches the mode, skip Pass 2.

## Real dogfood gate

After automated tests pass:

1. launch NightShift on the new build;
2. queue one small real `Delegated Leader` coding task;
3. do not write manual Follow-ups;
4. observe whether Luna evaluates the Worker result and launches corrections itself;
5. accept only `completed` if validation passed and Luna returned DONE.

## After the gate passes

Then resume secondary work in this order:

1. human-readable Progress timeline from Leader/attempt events;
2. cleanup/deletion lifecycle;
3. Sequential Batch UX reconsideration;
4. Leader model/attempt policy UI;
5. optional model escalation;
6. final Review/Integration automation policy.

## Quota discipline

Until the real dogfood gate passes:

- one implementation branch at a time;
- no parallel speculative branches;
- no cosmetic tickets;
- no large duplicate review passes;
- deterministic tests before another model review;
- one corrective implementation pass only when validation provides concrete errors.
