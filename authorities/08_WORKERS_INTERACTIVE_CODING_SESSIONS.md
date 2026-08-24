# 08 — Workers: Interactive Coding Sessions

## 1. Definition

Workers are persistent, manual, project-scoped conversations with external coding agents.

Examples:
- Codex + Nemotron Super;
- Claude Code + another FCC model;
- OpenCode + compatible model.

A Worker is intentionally similar to opening a dedicated coding-agent conversation in that agent's native client, but hosted and organized inside NightShift.

## 2. Worker creation

User chooses before conversation starts:

```text
Workspace
Agent
Model
Permission Profile
Isolation Mode
```

Agent and Model are locked once the Worker is created/activated.

## 3. Why lock Agent and Model

This guarantees:
- reproducibility;
- coherent session history;
- understandable behavior;
- clean benchmarking;
- fewer hidden context changes.

Changing model/agent creates a new Worker, optionally cloned from metadata/context later.

## 4. Permission profiles

Decision: configurable per Worker.

Recommended V1 profiles:

### Read Only
- inspect files;
- search;
- Git read operations;
- no edits.

### Workspace Write
- read/edit/test;
- ordinary commands;
- direct active Workspace;
- no destructive Git operations by default.

### Isolated Write
- NightShift worktree;
- read/edit/test;
- suitable for risky/experimental work.

### Custom
Future advanced allow/deny settings.

## 5. Git policy for Workers

Workers are not forced into worktrees.

Direct-workspace mode is allowed because manual interactive agents can operate usefully in a dirty working tree and the user is actively supervising.

Still:
- agent must not silently discard unrelated changes;
- reset/clean/force-push remain guarded;
- raw destructive operations should require explicit user permission.

## 6. Worker session persistence

NightShift stores:
- Worker identity;
- Agent;
- Model;
- Workspace;
- permission/isolation config;
- normalized transcript/events;
- external agent session ID if available;
- process/session state.

Across app restarts:
- if harness supports resume, adapter should reconnect/resume;
- otherwise NightShift may preserve history but clearly mark the external agent session as non-resumable.

Do not pretend session continuity where the harness does not support it.

## 7. Conversation UI

Preferred:
- user messages;
- agent messages;
- system/status events;
- tool/action summaries;
- timestamps where useful.

Raw terminal output remains available as a secondary/debug view.

## 8. Structured vs raw agents

NightShift should not scrape arbitrary ANSI terminal output into fake chat messages.

Adapter may expose:

```text
renderMode = structured | terminal | hybrid
```

## 9. Worker input

The bottom composer contains Worker message input.

Agent/model selectors may be visually shown as locked metadata after Worker creation.

No Priority field in Workers.

Priority belongs to Planner automation only.

## 10. Convert Worker → Planner

Future important action:

```text
Worker discussion
→ Add as Planner Task
```

The user chooses which instruction/context to convert.

This should not automatically dump entire conversation history into Task prompt.

## 11. Run → Worker

Future important action:

```text
failed/completed Run
→ Open in Worker
```

NightShift creates a new Worker with:
- same Workspace or worktree/candidate context as appropriate;
- suggested Agent/Model;
- concise Run summary/evidence.

Useful for manual intervention.

## 12. Workers and benchmarking

Worker sessions contribute telemetry, but interactive timing differs from automated Runs because user think-time exists.

Therefore:
- record agent/model/use;
- distinguish `interactive` from `planner_run`;
- do not compare wall-clock Worker duration directly to unattended Run duration without adjustment.
