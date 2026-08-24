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
- `design/Planner_Mockup_CURRENT.png`
- `design/Worker_Conversation_Mockup_CURRENT.png`

Legacy composition reference only:
- `design/Workspace_Mockup_LEGACY_COMPOSITION_REFERENCE.png`

The legacy mockup may still inform proportions, chrome, project tabs and the right explorer, but its older left-navigation labels are superseded by the V2 information architecture.

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
