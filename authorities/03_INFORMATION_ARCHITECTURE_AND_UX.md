# 03 — Information Architecture and UX

## 1. Primary navigation

V2 authority:

```text
Planner
Runs
Workers
Chats
GPT
```

No agent-specific primary tabs.

## 2. Persistent application regions

```text
┌─────────────────────────────────────────────────────────────────┐
│ Menu / NightShift chrome / window controls                     │
│ Workspace tabs                                                  │
├─────────────────────────────────────────────────────────────────┤
│ Terminal | Explorer | IDE              Active tool title        │
├───────────────┬───────────────────────────────┬─────────────────┤
│ Left nav      │                               │ Right Explorer  │
│               │       Central workspace       │                 │
│ Planner       │                               │ local files     │
│ Runs          │                               │                 │
│ Workers       │                               │                 │
│ Chats         │                               │                 │
│ GPT           │                               │                 │
└───────────────┴───────────────────────────────┴─────────────────┘
```

## 3. Workspace tabs

Each open project folder receives one top tab.

Switching tab changes all project-local context:
- Planner;
- Runs;
- Workers;
- Chats;
- file explorer root;
- later GPT project-local remembered state.

## 4. Planner UX

Current visual authority:
`design/Planner_Mockup_CURRENT.png`

Composer fields:

```text
Agent    [ Auto ▼ ]
Model    [ ... ▼ ]
Priority [ 1..n ▼ ]
Prompt
```

On submit:
- create Task;
- place in Planner queue;
- status `queued`.

Task row shows:
- task ordinal or title;
- prompt/title summary;
- requested/resolved Agent;
- Model;
- Priority;
- status;
- relevant relative timestamp/duration;
- archive `×` only when appropriate.

Clicking a Task opens its current/latest Run.

Completed Tasks remain visible until archived by user.

## 5. Runs UX

Runs are grouped by Workspace.

Left navigation may show a bounded recent list beneath `Runs`.

A Run detail view should eventually show:
- Task;
- status;
- Agent;
- Model;
- priority context;
- start/end/duration;
- base Git state;
- worktree path;
- normalized execution events;
- raw output fallback;
- validation;
- files changed;
- terminal result;
- retry/reopen actions.

The first vertical slice only needs enough Run detail to prove supervision.

## 6. Workers UX

Current visual authority:
`design/Worker_Conversation_Mockup_CURRENT.png`

Workers is an expandable collection of manual coding conversations.

### New Worker flow

Before first message, choose:
- Agent;
- Model;
- permissions;
- isolation mode.

After creation/first execution:
- Agent locked;
- Model locked;
- Workspace locked.

Permissions/isolation should not silently mutate mid-session.

If user wants another combination:
- create a new Worker;
- or later use a `Duplicate with…` action.

### Conversation rendering

Preferred UI is conversational, not a raw terminal wall.

However, NightShift must preserve access to raw agent output.

Adapter capability determines rendering:
- structured/event-capable harness → normalized conversation view;
- TUI-only or poorly structured harness → terminal/raw fallback.

Do not fake structured messages by brittle terminal scraping.

## 7. Chats UX

Chats visually resemble Workers but are semantically different.

Chats:
- do not modify repository;
- use read-only project context;
- use a lightweight model through FCC;
- do not need coding-agent branding.

## 8. GPT UX

GPT remains in primary nav even though implementation follows core vertical slice.

When implemented:
- central area hosts `chatgpt.com`;
- NightShift chrome/sidebar/explorer remain visible;
- local file explorer can attempt native drag into ChatGPT;
- external browser fallback exists.

## 9. Quick project buttons

Locked:
- Terminal;
- Explorer;
- IDE.

All operate on active Workspace root.

## 10. External application launcher

Top `Lancer` menu remains part of product direction.

Launcher entries are configurable:
- Fork;
- Adobe apps;
- other tools.

Do not hardcode product vendors in architecture.

## 11. Visual timestamps

Planner/Run rows may show:
- relative age while queued;
- elapsed duration while running;
- completion age after completion.

The data model stores absolute timestamps; relative labels are presentation only.

## 12. Empty states

Every major surface must handle:
- no workspace;
- no tasks;
- no runs;
- no workers;
- no chats;
- FCC offline;
- no supported agents installed;
- no models available.

Errors must state the actionable cause rather than silently disabling UI.
