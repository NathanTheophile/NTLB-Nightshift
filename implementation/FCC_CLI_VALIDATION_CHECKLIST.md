# FCC CLI Validation Checklist

Use this before application coding.

## A. Installation

```powershell
Get-Command fcc-server -ErrorAction SilentlyContinue
Get-Command fcc-claude -ErrorAction SilentlyContinue
Get-Command fcc-codex -ErrorAction SilentlyContinue
Get-Command fcc-pi -ErrorAction SilentlyContinue
Get-Command fcc-opencode -ErrorAction SilentlyContinue
Get-Command fcc-cline -ErrorAction SilentlyContinue
Get-Command fcc-hermes -ErrorAction SilentlyContinue
Get-Command fcc-dsh -ErrorAction SilentlyContinue
```

Record results.

Then:

```powershell
fcc-server --version
```

If command is unavailable but `uv run fcc-server` works from a clone, FCC is not installed globally in the expected NightShift-ready form.

## B. Server

- [ ] FCC server starts.
- [ ] Admin UI opens.
- [ ] health/port known.
- [ ] NVIDIA provider configured.
- [ ] model catalog visible.
- [ ] Lightning available.
- [ ] Super available.

## C. Codex

- [ ] `fcc-codex --version` or equivalent works.
- [ ] interactive session works.
- [ ] exec/headless command works.
- [ ] cwd can be set by launching from test repo.
- [ ] Lightning can be selected and verified.
- [ ] Super can be selected and verified.
- [ ] output capture behavior documented.
- [ ] cancellation tested.
- [ ] resume tested if supported.
- [ ] multi-agent/subagent behavior noted.

## D. Claude Code

Same matrix:
- [ ] launcher works.
- [ ] interactive.
- [ ] headless/print.
- [ ] cwd.
- [ ] Lightning.
- [ ] Super.
- [ ] output.
- [ ] cancellation.
- [ ] resume.
- [ ] subagents.

## E. Other detected FCC agents

Probe all installed launchers.

Do not require all to become Planner-ready.

## F. Deterministic probe task

Use one clean disposable Git repo.

Prompt:

```text
Create NIGHTSHIFT_AGENT_PROBE.txt in the repository root.
Its complete contents must be exactly:
NIGHTSHIFT_AGENT_PROBE_OK
Do not modify any other file.
Then report completion.
```

For each Agent/Model:
- fresh base;
- record start/end;
- inspect diff;
- record exit/result.

## G. Realistic probe task

Use one bounded real code bug after deterministic probe.

Do not change the prompt between combinations.

## H. Output document

Create:

```text
FCC_AGENT_CAPABILITY_MATRIX.md
```

with:
- commands;
- versions;
- capabilities;
- model selection;
- results;
- timings;
- recommendation for first NightShift adapter.
