# 16 — FCC Validation Protocol

This protocol is the immediate pre-development technical gate.

## 1. Objective

Before NightShift writes agent adapters, determine the real capabilities of FCC-backed coding agents on the current machine.

The goal is not to crown a permanent “best agent”.

The goal is to produce a trustworthy capability matrix.

## 2. Install/command gate

Verify global commands:

```powershell
Get-Command fcc-server,fcc-claude,fcc-codex,fcc-pi,fcc-opencode,fcc-cline,fcc-hermes,fcc-dsh -ErrorAction SilentlyContinue
```

Record which exist.

If FCC is only being run from a source checkout through `uv run`, fix installation/PATH before treating the environment as NightShift-ready.

## 3. Server gate

Record:
- FCC version;
- URL/port;
- health;
- Admin reachable;
- selected provider;
- model catalog available.

Do not rely on “server terminal is open” as the only health signal.

## 4. Agent probe

For each detected agent, record:

```text
command
version
interactive start
headless/exec mode
working-directory support
model selection method
structured output
resume
cancel
subagents/multi-agent support
images
known restrictions
```

## 5. Model enforcement test

Critical.

For at least:
- Nemotron Lightning;
- Nemotron Super;

prove that the agent actually uses the requested model.

Do not infer from UI label alone if FCC/agent can expose stronger evidence.

## 6. Controlled task

Use one tiny deterministic repository task:

```text
Create a file NIGHTSHIFT_AGENT_PROBE.txt
with exact requested content,
then report completion.
```

Requirements:
- same clean repo base;
- same prompt;
- same model;
- separate work directory;
- no push.

Measure:
- wall time;
- process exit;
- output format;
- changed files;
- model evidence;
- cancellation behavior separately.

## 7. Realistic task

Then use one real bounded bug:
- requires repository investigation;
- modest code edit;
- validation.

Do not benchmark only exact marker edits.

## 8. Planner validation criteria

An Agent/Model path becomes `plannerValidated` only if NightShift can determine how to:

1. start non-interactively;
2. select exact Workspace/worktree cwd;
3. select/resolve exact requested model;
4. avoid login prompts;
5. capture enough output/status;
6. cancel;
7. detect terminal completion;
8. preserve changes;
9. distinguish failure.

Structured JSON is strongly preferred but not absolutely required if another stable adapter surface exists.

## 9. Worker validation criteria

Less strict.

A path can become `workerValidated` if:
- interactive PTY starts reliably;
- cwd is correct;
- chosen model can be established;
- user can converse/code;
- session can terminate safely.

Resume is desirable but not mandatory for first Worker support.

## 10. Capability matrix output

Create a table like:

| Agent | Installed | Worker | Planner | Model override | Structured | Resume | Notes |
|---|---:|---:|---:|---:|---:|---:|---|
| Codex | | | | | | | |
| Claude Code | | | | | | | |
| Pi | | | | | | | |
| OpenCode | | | | | | | |
| Cline | | | | | | | |
| Hermes | | | | | | | |
| DeepSeek Harness | | | | | | | |

The actual current FCC list must be discovered rather than assumed forever.

## 11. First adapter selection

Choose the first NightShift adapter using:
- Planner validation success;
- clean model override;
- stable output;
- cancellation;
- good realistic-task result;
- reasonable latency.

Not familiarity or reputation alone.
