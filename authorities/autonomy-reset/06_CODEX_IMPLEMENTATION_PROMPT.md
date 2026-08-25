# 06 — CODEX IMPLEMENTATION PROMPT

Use this as the next external implementation task.

---

You are implementing the core autonomous Delegated Leader vertical slice for `NathanTheophile/NTLB-Nightshift`.

Base your work on the real current `dev` HEAD and verify it before editing. Expected reset baseline when this pack was authored: `5f49e0b077d495f2e3cd7202ed29dfdfe06a7893`.

Read these reset documents first and treat them as authority for the autonomous Planner path:

- `START_HERE.md`
- `00_AUTONOMOUS_MASTER_AUTHORITY.md`
- `01_LUNA_LEADER_PROTOCOL.md`
- `02_RUN_AND_ATTEMPT_MODEL.md`
- `03_REUSE_REFACTOR_DEPRECATE.md`
- `04_IMPLEMENTATION_SEQUENCE.md`
- `05_ACCEPTANCE_TESTS.md`
- `07_DECISIONS_LOCKED.md`

Then read the repository's existing authority and relevant current implementation before changing code.

## Mission

Implement the smallest production-quality backend vertical slice that makes `delegated_leader` genuinely autonomous.

The user already has OpenAI/ChatGPT connected in FCC. The Delegated Leader default is Luna through FCC. Resolve the exact live FCC model ID from FCC; do not invent or hardcode an unverified OpenAI model slug.

Required behavior:

```text
Planner Task
→ one delegated Run
→ one isolated worktree
→ Luna Leader decision
→ fresh coding Worker attempt
→ deterministic validation
→ bounded evidence to Luna
→ Luna decides WORK / DONE / BLOCKED
→ WORK automatically launches another fresh Worker attempt in the SAME worktree
→ repeat within bounded attempt + whole-Run timeout
→ DONE completes only when deterministic validation passed
→ BLOCKED preserves evidence/worktree
```

There must be no human-written Follow-up and no intermediate Candidate push in this loop.

## Architectural constraints

- Keep Electron/React/TypeScript/Vite/SQLite/Windows-first architecture.
- FCC remains the only model/provider gateway.
- Do not use browser automation or private ChatGPT APIs.
- Do not create a second direct OpenAI provider integration.
- Leader is non-writing and receives bounded evidence.
- Workers continue through existing validated `AgentAdapter`s.
- Retain existing Git/process safety.
- One delegated Run owns one worktree for all attempts.
- Fresh Worker invocation per attempt.
- Existing manual Single Agent / Sequential Batch / Follow-up / Candidate / Review features may remain, but Delegated Leader must not depend on them.
- Do not redesign the UI.
- Do not implement autonomous merge to `dev`.
- Do not add model escalation or multi-agent swarms.
- Do not broaden scope.

## Implementation structure

Prefer a dedicated orchestration boundary such as `DelegatedRunOrchestrator`; do not stuff the whole state machine into the already-large `RunService`.

Add a strict typed Leader protocol and parser. Malformed output gets at most one protocol repair call, then blocks.

Extend the existing FCC gateway narrowly for Leader inference. The current gateway already owns FCC health/model catalog; reuse it.

Add persistent autonomous Worker attempts and associate delegated validation evidence with attempts. Preserve legacy rows/behavior.

Use the existing Run hard timeout as the whole autonomous mission deadline. Cancellation must stop whichever phase is active.

On restart, an interrupted delegated Run should become safely blocked with its worktree/evidence preserved; do not blindly resume V1 orchestration.

## Tests

Implement all tests in `05_ACCEPTANCE_TESTS.md`, especially the deterministic two-attempt correction test:

```text
attempt 0 validation fails
→ Leader returns WORK
→ attempt 1 corrects same worktree
→ validation passes
→ Leader returns DONE
→ same Run completes
```

Assert there is no intermediate publish/push and no manual Follow-up.

Preserve existing test coverage for legacy modes.

## Validation

Run and fix all failures from:

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

Do not report completion while any fail.

## Deliverable

One coherent implementation branch/commit suitable for review, with the autonomous backend acceptance tests green.

Do not implement unrelated cleanup or cosmetic work.
