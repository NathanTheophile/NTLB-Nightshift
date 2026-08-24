# NightShift V2 Authority Pack

**Authority date:** 2026-08-24  
**Status:** ACTIVE PRODUCT AUTHORITY  
**Supersedes:** the previous NightShift Master Pack / Qwen-first architecture.

NightShift V2 is a clean product redefinition. The previous Qwen-centric work remains useful as experimental history, but it is **not** the active product architecture.

## Read order

Read the authority documents in this order:

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

> **NightShift is a Windows desktop project hub that combines project context, manual coding-agent conversations, non-coding project chats, and an automated priority Planner that launches isolated coding Runs through FCC.**

## Most important architectural boundary

NightShift does **not** implement its own LLM coding brain.

NightShift owns:

- workspaces;
- UI;
- task queue;
- execution lifecycle;
- isolation;
- agent/model selection;
- state;
- logs;
- benchmarking;
- safety;
- persistence.

The selected external coding agent owns:

- coding reasoning;
- tool use;
- edits;
- tests;
- subagents/multi-agent behavior when supported.

FCC is the mandatory V1 model/provider gateway for coding-agent and NightShift-chat model access.