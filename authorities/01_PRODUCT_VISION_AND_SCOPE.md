# 01 — Product Vision and Scope

## 1. Problem

Modern coding agents are powerful but fragmented.

A developer may have:
- one local repository;
- several coding-agent CLIs;
- many available models/providers;
- normal ChatGPT discussions;
- local project notes;
- tasks they want to queue overnight;
- manual tasks they want to perform interactively;
- multiple agent/model combinations they want to compare.

The existing tools usually optimize for **one interactive agent session**.

NightShift optimizes for the **project as the stable center**.

## 2. Product vision

NightShift is a desktop cockpit around a project directory.

The user opens NightShift and remains inside one project context while they can:
- queue autonomous work;
- inspect currently running/recent work;
- open persistent manual coding conversations;
- have lighter non-coding project discussions;
- use embedded ChatGPT later;
- drag local project files into external conversation surfaces later;
- open terminal, Explorer or IDE immediately;
- compare coding-agent/model performance from real work.

## 3. Primary user loop

### During active work

```text
Open workspace
→ inspect files / discuss
→ create a Worker conversation
→ ask Codex/Claude/etc. to code interactively
→ continue normal development
```

### Preparing automation

```text
Open Planner
→ add Task
→ choose Agent / Model / Priority
→ queue Task
```

### During automation

```text
Planner chooses highest-priority queued Task
→ creates isolated Run
→ selected coding agent starts through FCC
→ Run records output/events
→ coding agent performs work
→ Run completes/fails/blocks
→ Planner advances to next Task
```

### Reviewing

```text
Click Task
→ open its latest Run
→ inspect logs/result/files/validation
→ retry if needed
→ remove completed Task from visible Planner when desired
```

Removing a completed Task from the Planner does not delete its Run history.

## 4. Product surfaces

### Planner
Intent and queue.

### Runs
Execution records.

### Workers
Manual coding conversations with full coding-agent capability according to permissions.

### Chats
Non-coding project conversations using a lighter model path through FCC and read-only project access.

### GPT
Embedded `chatgpt.com` workspace after the core agentic vertical slice.

## 5. Why Workers instead of Codex/Claude tabs

NightShift must not make primary navigation depend on current vendors.

A Worker conversation stores:

```text
agent
model
workspace
permissions
isolation mode
session identity
```

If tomorrow FCC supports another coding agent, the UI architecture does not change.

## 6. Why FCC is central

FCC is used because V1 needs:
- one model/provider gateway;
- model catalog;
- compatibility handling;
- coding-agent launchers;
- support for multiple external harnesses;
- free/subscription/local provider options without building each provider integration from scratch.

NightShift does not market FCC tokens/models as its own.

FCC remains a separate external dependency/project.

## 7. What NightShift is not

NightShift V1 is not:
- a complete IDE;
- a Git GUI replacement;
- an LLM model;
- a coding harness;
- a custom multi-agent reasoning framework;
- a SaaS;
- a provider marketplace;
- a paid OpenAI/Anthropic API client;
- a ChatGPT scraper;
- browser automation around private ChatGPT APIs.

## 8. Value proposition

NightShift should eventually answer four practical needs from one app:

```text
“What do I want done?”
→ Planner

“What is happening / what happened?”
→ Runs

“I want to work with a coding agent right now.”
→ Workers

“I just want to discuss/understand the project.”
→ Chats / GPT
```

## 9. Success criteria

NightShift succeeds when:
- adding and supervising autonomous project work is lower-friction than manually driving separate terminals;
- changing agent/model does not require reconfiguring the whole environment;
- real performance data accumulates automatically;
- a user can leave a queue running unattended without risking the shared workspace;
- the project context remains coherent across tools.
