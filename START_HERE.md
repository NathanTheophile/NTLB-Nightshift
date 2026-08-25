# NightShift V2 Authority Pack

**Authority date:** 2026-08-25  
**Status:** ACTIVE PRODUCT AUTHORITY  
**Supersedes:** the previous NightShift Master Pack / Qwen-first architecture.

NightShift V2 is a clean product redefinition. The previous Qwen-centric work remains useful as experimental history, but it is **not** the active product architecture.

## Autonomy reset — precedence rule

The autonomous Planner / Delegated Leader architecture was recentered on 2026-08-25.

For all topics involving:

- autonomous Planner behavior;
- `delegated_leader`;
- Leader orchestration;
- Luna as Delegated Leader through FCC;
- autonomous Worker attempts;
- automatic correction/retry;
- Run vs attempt semantics for Delegated Leader;
- intermediate checkpoints/candidates during autonomous execution;
- autonomous validation feedback loops;

the authority under:

- `authorities/autonomy-reset/START_HERE.md`

and the documents it references **takes precedence over any conflicting statement in the older NightShift V2 authority documents**.

In particular, this precedence applies over conflicting semantics in:

- `authorities/01_PRODUCT_VISION_AND_SCOPE.md`
- `authorities/05_RUNTIME_ARCHITECTURE.md`
- `authorities/07_PLANNER_AND_RUNS.md`
- `authorities/10_GIT_ISOLATION_AND_SAFETY.md`
- `authorities/14_MVP_AND_IMPLEMENTATION_SEQUENCE.md`
- `authorities/15_DECISION_REGISTER_AND_OPEN_QUESTIONS.md`

The autonomy reset is a **functional architecture reset, not a repository rewrite**. Existing infrastructure and non-conflicting authority remain active.

### Autonomous Planner authority read order

Before implementing or modifying the autonomous Planner / Delegated Leader path, read:

1. `authorities/autonomy-reset/START_HERE.md`
2. `authorities/autonomy-reset/00_AUTONOMOUS_MASTER_AUTHORITY.md`
3. `authorities/autonomy-reset/01_LUNA_LEADER_PROTOCOL.md`
4. `authorities/autonomy-reset/02_RUN_AND_ATTEMPT_MODEL.md`
5. `authorities/autonomy-reset/03_REUSE_REFACTOR_DEPRECATE.md`
6. `authorities/autonomy-reset/04_IMPLEMENTATION_SEQUENCE.md`
7. `authorities/autonomy-reset/05_ACCEPTANCE_TESTS.md`
8. `authorities/autonomy-reset/07_DECISIONS_LOCKED.md`

`authorities/autonomy-reset/06_CODEX_IMPLEMENTATION_PROMPT.md` is an implementation mission document, not a general product authority.

## Read order

For all non-conflicting NightShift V2 product areas, read the authority documents in this order:

1. `authorities/00_MASTER_AUTHORITY.md`
2. `authorities/01_PRODUCT_VISION_AND_SCOPE.md`
3. `authorities/02_TERMINOLOGY_AND_DOMAIN_MODEL.md`
4. `authorities/03_INFORMATION_ARCHITECTURE_AND_UX.md`
5. `authorities/04_DESIGN_AUTHORITY.md`
6. `authorities/05_RUNTIME_ARCHITECTURE.md`
7. `authorities/06_FCC_GATEWAY_AND_AGENT_CATALOG.md`
8. `authorities/07_PLANNER_AND_RUNS.md`
9. `authorities/08_WORKERS_INTERACTIVE_CODING_SESSIONS.md`
10. `authorities/09_CHATS_AND_GPT.md`
11. `authorities/10_GIT_ISOLATION_AND_SAFETY.md`
12. `authorities/11_DATA_MODEL_AND_SQLITE.md`
13. `authorities/12_BENCHMARKING_AND_TELEMETRY.md`
14. `authorities/13_SECURITY_AND_PROCESS_MODEL.md`
15. `authorities/14_MVP_AND_IMPLEMENTATION_SEQUENCE.md`
16. `authorities/15_DECISION_REGISTER_AND_OPEN_QUESTIONS.md`
17. `authorities/16_FCC_VALIDATION_PROTOCOL.md`

When one of these documents conflicts with the autonomy-reset authority on an autonomous Planner topic, **the autonomy-reset authority wins**.

Then use:

- `implementation/NEXT_STEPS.md`
- `implementation/FCC_CLI_VALIDATION_CHECKLIST.md`

## Primary visual authorities

Current:

- `design/mockups/planner.png`
- `design/mockups/worker-conversation.png`

Production UI assets are stored under:

- `design/assets/buttons/`
- `design/assets/icons/`
- `design/assets/images/`
- `design/assets/logos/`
- `design/assets/misc/`

The current mockups define the intended composition, density, chrome, navigation and general visual identity of NightShift V2.

The exported production assets should be reused by the implementation where appropriate rather than replaced with generic substitutes.

## Core sentence

> **NightShift is a Windows desktop project hub that combines project context, manual coding-agent conversations, non-coding project chats, and an automated priority Planner whose primary autonomous mode uses an external Delegated Leader to supervise isolated coding work through FCC until the task is completed or safely blocked.**

## Most important architectural boundary

NightShift does **not** implement its own LLM coding brain.

NightShift owns:

- workspaces;
- UI;
- task queue;
- orchestration lifecycle;
- isolation;
- agent/model selection;
- state;
- logs;
- deterministic validation;
- bounded evidence delivery;
- benchmarking;
- safety;
- persistence.

For autonomous Planner work, the external Delegated Leader owns:

- interpreting the Task;
- evaluating implementation evidence;
- deciding whether more work is required;
- issuing corrective Worker instructions;
- deciding `WORK`, `DONE`, or `BLOCKED`.

The selected external coding Worker owns:

- coding reasoning;
- tool use;
- edits;
- tests;
- subagents/multi-agent behavior when supported.

FCC is the mandatory V1 model/provider gateway for coding-agent, Delegated Leader and NightShift-chat model access.
