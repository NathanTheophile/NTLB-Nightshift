# 00 — Master Authority

## 1. Authority status

This document and the other files under `authorities/` define the active NightShift V2 product.

Where a previous NightShift document conflicts with this pack, **this pack wins**.

The earlier Qwen-first architecture is historical experimentation, not active product policy.

## 2. Product identity

NightShift is not merely an overnight bot and is not merely a frontend for one coding agent.

It is a **general project workspace / hub** centered on a local folder, with five major user surfaces:

```text
Planner
Runs
Workers
Chats
GPT
```

The workspace also exposes:
- a local file explorer;
- one-click Terminal;
- one-click Windows Explorer;
- one-click configured IDE;
- external application launching;
- project tabs.

## 3. V2 core architecture

```text
                               NIGHTSHIFT
                     Electron / React / TypeScript
                                  │
          ┌───────────────────────┼────────────────────────┐
          │                       │                        │
       Workspace               Planner                  Workers
          │                       │                        │
          │                  queued Tasks            manual coding
          │                       │                   conversations
          │                       ▼                        │
          │                   Run Engine                   │
          │                       │                        │
          └───────────────────────┼────────────────────────┘
                                  ▼
                           Agent Registry
                    detected FCC coding agents
                                  │
                                  ▼
                                FCC
                          model/provider gateway
                                  │
                                  ▼
                         selected model/provider
```

`Chats` also use FCC, but do not use a coding harness by default.

`GPT` is an embedded ChatGPT web workspace planned after the core vertical slice.

## 4. Official V1 constraints

### Mandatory
- Windows desktop first.
- Electron + React + TypeScript + Vite.
- SQLite from the start.
- FCC mandatory gateway in V1.
- Detect all FCC-supported installed coding agents.
- Planner Tasks have agent, model and priority.
- `Auto` agent/model is permitted; initially it means configured defaults, not intelligent routing.
- Priority 1 is highest.
- Only one top-level Planner Task executes at a time in V1.
- Each automated write-capable Run is Git-isolated in a worktree.
- A Task attempt maps to one Run. Retry creates a new Run.
- Worker coding conversations lock agent + model after creation.
- Worker permissions are configurable.
- Workers can be direct-workspace or isolated.
- Execution telemetry is always recorded.
- OpenAI/Anthropic paid API usage is out of official V1 scope.
- Qwen is not an active V1 dependency.

### Deferred
- embedded GPT to V1.1/core-followup;
- intelligent auto-routing;
- top-level parallel Planner Runs;
- polished benchmark dashboards;
- full Git candidate/review system;
- local/offline LLM requirement.

## 5. V1 sequencing authority

Do not build the entire hub before proving the runtime.

Do not build a backend-only CLI and postpone the product UI indefinitely.

The official sequence is:

```text
A. Validate FCC + coding-agent CLI behavior outside NightShift
B. Build a thin Electron shell matching the design authorities
C. Immediately implement one complete Planner → Run vertical slice
D. Add more detected/validated agent adapters
E. Expand Workers
F. Expand hub features: Chats, GPT, launchers, richer history, Git review
```

This is a deliberate hybrid between “shell first” and “vertical slice first”.

## 6. FCC boundary

FCC is mandatory in V1 because it already solves the shared model/provider gateway problem for multiple coding agents.

However, NightShift code must still keep a clean internal boundary:

```text
NightShift
→ FccGateway service
→ external FCC process/API/launchers
```

NightShift business logic must not be scattered with FCC implementation details.

This is **not** a commitment to support a second gateway in V1. It is simply maintainable architecture.

## 7. Product rule

NightShift is organized by **work type**, not by vendor branding.

Therefore:

```text
GOOD
Planner / Runs / Workers / Chats / GPT

NOT V2
Planner / Claude / Codex / OpenCode / ...
```

Coding-agent choice belongs inside Task/Run/Worker configuration, not in primary navigation.
