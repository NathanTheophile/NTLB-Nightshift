# 14 — MVP and Implementation Sequence

## 1. Development principle

NightShift should reach a real agentic vertical slice quickly, but the user already has a strong UI direction that should not be discarded.

Therefore the official approach is:

> **thin shell first, real vertical slice immediately after.**

Not:
- full frontend first;
- backend-only first.

## Phase 0 — Documentation authority

Complete:
- this V2 pack;
- current mockups;
- decisions.

No application coding before this authority is accepted.

## Phase 1 — FCC CLI validation

Outside NightShift, validate:
- FCC install/launchers;
- agent discovery;
- model discovery;
- selected model enforcement;
- Codex behavior;
- Claude Code behavior;
- additional FCC agents where practical;
- headless modes;
- streaming/output;
- cancellation;
- resume;
- working directory;
- subagent behavior where relevant.

This phase decides which agents are `plannerValidated`.

## Phase 2 — Thin Electron shell

Codex or another trusted coding agent builds only enough UI infrastructure to establish product shape:

Required:
- Electron/React/TS/Vite;
- SQLite migration foundation;
- custom NightShift chrome;
- workspace picker/tabs;
- primary nav:
  - Planner;
  - Runs;
  - Workers;
  - Chats;
  - GPT placeholder;
- right explorer skeleton;
- Terminal / Explorer / IDE quick buttons;
- Planner UI matching mockup with local DB Tasks;
- Worker conversation shell matching mockup with no broad runtime complexity yet.

Do not finish every feature.

## Phase 3 — First real vertical slice

Goal:

```text
Open Git Workspace
→ create Planner Task
→ choose validated Agent
→ choose FCC Model
→ Priority
→ queue
→ NightShift creates isolated worktree
→ launches selected agent via FCC
→ creates Run
→ streams output/status
→ completes/fails
→ Planner updates
→ click Task opens Run
```

This is the first definition of “NightShift works”.

## Phase 4 — Second agent + benchmark

Add/validate a second coding agent.

Run controlled comparisons:
- same task;
- same base;
- same model;
- different agent.

Then:
- same agent;
- different model.

## Phase 5 — Workers real execution

Connect Worker conversations:
- Agent/Model selection at creation;
- lock values;
- permissions;
- direct vs isolated;
- session persistence/resume where supported;
- normalized conversation events;
- raw terminal fallback.

## Phase 6 — Robust unattended Planner

Add:
- timeouts;
- cancellation;
- queue continuation;
- retries as explicit new Runs;
- crash/restart recovery;
- worktree cleanup policy;
- stronger validation.

At this point overnight use becomes a legitimate product claim.

## Phase 7 — Chats

Implement FCC-backed lightweight project chats:
- selected lightweight model;
- read-only project tools;
- persistence;
- Chat → Planner action later.

## Phase 8 — GPT

Implement:
- embedded ChatGPT;
- persistent login;
- file-drag POC;
- fallback.

## Phase 9 — Hub expansion

Add:
- configurable `Lancer`;
- richer Runs/history;
- Git candidate review;
- benchmark analytics;
- additional FCC agents;
- better model compatibility UI.

## Phase 10 — Intelligent routing

Only after real benchmark evidence:
- recommendations;
- optional Auto routing.

## 2. What Codex should build first

After Phase 1 validation, Codex should receive:
- V2 authority pack;
- design assets;
- explicit Phase 2 + Phase 3 scope.

Do not hand it the old Master Pack.

## 3. Why not let Workers build the initial shell

Workers do not exist until the shell/runtime exists.

Dogfooding starts as soon as Phase 3 works.

From then onward, NightShift itself can queue NightShift development tasks.

## 4. First dogfooding milestone

```text
NightShift repository
→ NightShift Planner
→ real Run
→ coding agent through FCC
→ change NightShift
```

That is the point where the tool starts developing itself.
