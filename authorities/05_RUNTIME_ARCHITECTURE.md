# 05 — Runtime Architecture

## 1. Desktop stack

Locked:

```text
Electron
React
TypeScript
Vite
SQLite
Windows-first
```

## 2. Runtime layers

```text
Renderer
  React UI
     │
     ▼
Preload / Typed IPC
     │
     ▼
Electron Main
  ├ WorkspaceService
  ├ DatabaseService
  ├ PlannerService
  ├ RunService
  ├ WorktreeService
  ├ AgentRegistry
  ├ AgentExecutionService
  ├ WorkerSessionService
  ├ FccGateway
  ├ ProcessSupervisor
  ├ LauncherService
  └ later GptViewService
```

## 3. FCC as mandatory V1 gateway

All model-backed V1 paths use FCC:

```text
Coding agent → FCC → selected model/provider
Chat runtime → FCC → selected lightweight model/provider
```

NightShift must not contain separate OpenAI/Anthropic paid API integrations in V1.

## 4. Agent execution architecture

A coding agent is external software.

NightShift launches and supervises it rather than embedding its source code.

Conceptual API:

```ts
interface AgentAdapter {
  detect(): Promise<AgentDetection>;
  capabilities(): AgentCapabilities;

  startWorker(spec: WorkerStartSpec): Promise<WorkerHandle>;
  startRun(spec: RunStartSpec): Promise<RunHandle>;

  cancel(handleId: string): Promise<void>;
  resume?(sessionId: string): Promise<WorkerHandle>;
}
```

The exact interface can evolve; the separation is authority.

## 5. Detection vs validation

NightShift must distinguish:

```text
Detected
Installed
Launchable
Validated for interactive Worker
Validated for Planner automation
```

A launcher being present does not prove:
- model selection works;
- headless mode is reliable;
- output is machine-readable;
- cancellation is safe;
- resume works.

## 6. Agent registry

V1 product intent is to detect **all FCC-supported installed coding agents**.

Do not hardcode UI to Codex/Claude only.

But Planner execution must be capability-gated.

Example:

```text
Codex
installed: true
worker: validated
planner: validated

Cline
installed: true
worker: terminal-only
planner: not validated
```

## 7. Capability descriptor

Recommended flags:

```text
interactive
headless
structuredEvents
rawPty
resume
modelOverride
cancel
workingDirectory
imageInput
subagents
plannerValidated
workerValidated
```

These are facts NightShift learns from adapters/validation, not marketing assumptions.

## 8. Process supervision

Every external agent process should have:
- stable internal execution ID;
- PID/process tree tracking;
- working directory;
- start time;
- last output time;
- cancellation state;
- exit code;
- stdout/stderr or PTY event source.

NightShift must be able to terminate the process tree it owns.

## 9. Interactive Workers

Workers may use PTY because many coding agents are terminal-native.

Preferred technical direction:
- `node-pty` or equivalent in Electron main;
- normalized event layer where supported;
- xterm/raw terminal fallback where not.

The central product UX remains conversational when reliable structured output exists.

## 10. Automated Runs

Planner Runs should prefer non-interactive/headless execution modes when supported.

Automation requires:
- deterministic selected model;
- known cwd;
- no uncontrolled login prompt;
- detectable terminal state;
- cancellation;
- captured result/output;
- isolated worktree.

If an agent cannot meet these requirements, it can remain Worker-only until an adapter is validated.

## 11. Model selection

NightShift cannot assume all agents accept the same `--model` flag.

The Agent Adapter owns **model application strategy**.

Possible strategies:
- command argument;
- environment variable;
- temporary process-local config;
- FCC launcher integration;
- native model picker automation only if reliable and non-brittle.

Planner validation must prove the requested model actually ran.

## 12. No custom LLM orchestrator

Planner decides when to start a Task.

It does not decompose coding work itself.

If Codex/Claude/etc. launches subagents internally, that remains inside the harness execution.

NightShift may observe it where exposed, but does not reimplement it.
