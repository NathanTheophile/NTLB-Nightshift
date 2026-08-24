# 02 — Terminology and Domain Model

Terminology is normative. Product UI, code, database and documentation should use these words consistently.

## Workspace

A local project folder opened in NightShift.

Properties:
- root path;
- display name;
- optional Git repository metadata;
- settings;
- open UI state.

A Workspace may be non-Git for browsing/Chats/Workers, but **automated write-capable Planner Runs require Git in V1** because automated isolation is mandatory.

## Task

A user-authored Planner item representing desired work.

A Task is intent, not execution.

Core fields:

```text
id
workspaceId
title/prompt
agentSelection
modelSelection
priority
status
createdAt
updatedAt
visibleInPlanner
```

A Task may have multiple Runs because retries create new Runs.

## Priority

Integer priority used by Planner scheduling.

Authority:

```text
Priority 1 = highest priority.
Larger number = lower priority.
```

At equal priority, older queued Task executes first.

## Run

One execution attempt of one Planner Task.

A Run is immutable historical evidence after completion.

Core identity:

```text
Run
→ exactly one Task
→ exactly one resolved Agent
→ exactly one resolved Model
→ exactly one base Git state
→ exactly one execution attempt
```

A retry is a new Run.

## Worker Conversation

A manual coding-agent session created by the user.

It is **not** a Planner Run.

A Worker Conversation has:
- one Workspace;
- one coding Agent;
- one Model;
- one permission profile;
- one isolation mode;
- one agent session identity where supported;
- many conversational turns/events.

Agent and Model are locked for the lifetime of the conversation after creation.

## Chat Conversation

A non-coding project discussion.

It is NightShift-native, not ChatGPT.

It uses:
- FCC;
- a selected lightweight model;
- NightShift-managed read-only project capabilities.

It should not invoke a full coding harness unless future evidence justifies doing so.

## GPT

The embedded ChatGPT web product.

GPT is separate from NightShift Chats.

NightShift does not treat GPT conversation contents as local structured data unless the user explicitly exports/imports something in a future feature.

## Coding Agent / Harness / Agent

These terms refer to external coding-agent software such as:
- Claude Code;
- Codex;
- Pi;
- OpenCode;
- Cline;
- Hermes;
- DeepSeek Harness;
- other FCC-supported agents.

UI label: **Agent**.

Code/documentation may use `Harness` when discussing execution adapters.

The model is not the harness.

## Model

The inference model selected through FCC.

Agent and Model are separate axes.

## Agent Descriptor

NightShift metadata describing a detected coding agent and its capabilities.

Example:

```text
id
displayName
fccLauncher
installed
interactive
headless
structuredOutput
resume
cancel
modelSelectionStrategy
validatedForPlanner
validatedForWorkers
```

## Agent Adapter

NightShift code that knows how to start, monitor, stop, and normalize one class of coding-agent execution.

Detection and execution are separate:
- an agent can be detected;
- but not yet validated for Planner automation.

## FCC Gateway

The mandatory V1 shared model/provider gateway.

NightShift talks to FCC through a dedicated service boundary.

## Execution Mode

### Direct Workspace
Agent operates in the actual Workspace folder.

Allowed for Workers according to permission profile.

### Isolated Worktree
Agent operates in a NightShift-owned Git worktree.

Mandatory for write-capable Planner Runs.

Optional for Workers.

## Auto

`Auto` is allowed for Agent and Model.

V1 authority:

```text
Auto ≠ AI router.
Auto = use configured default resolution policy.
```

Intelligent routing based on benchmarks is future work.

## Planner status

Suggested Task states:

```text
queued
running
completed
failed
blocked
cancelled
```

A Task's displayed state is derived partly from its latest Run.

## Run status

Suggested Run states:

```text
preparing
running
completed
failed
blocked
cancel_requested
cancelled
timed_out
```

## Worker status

Suggested states:

```text
idle
starting
active
waiting_for_user
terminated
error
```

## Archive

Removing a Task from visible Planner means:

```text
visibleInPlanner = false
```

It does not delete Task or Run history.
