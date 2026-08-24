# 12 — Benchmarking and Telemetry

## 1. Decision

Telemetry is always collected for Runs.

Benchmarking is a first-class consequence of normal usage, not a separate special mode.

## 2. Why

NightShift needs empirical answers to:
- which Agent works best with which Model;
- which combinations are fastest;
- which fail;
- which require retries;
- which produce validated changes;
- which are suitable for specific task classes.

The product should learn from actual work rather than subjective reputation.

## 3. Required Run metrics

When available:

```text
agent
agent version
model
provider/ref
task
priority
base SHA
start time
finish time
wall duration
process exit code
status
retry/attempt number
tool/action counts if exposed
turn counts if exposed
input/output/cached tokens if exposed
subagent count if exposed
files changed
lines changed
validation result
human review result later
failure reason
```

Missing data is acceptable; fake data is not.

## 4. Worker metrics

Record:
- Agent;
- Model;
- session start;
- process active time where measurable;
- errors;
- tool/turn counts where exposed.

Do not use total wall-clock Worker duration as direct performance metric because user think-time contaminates it.

## 5. Quality is more important than latency

A fast incorrect Run is not a winner.

Later benchmark score can incorporate:
- validation success;
- human acceptance;
- no regressions;
- first-attempt completion;
- time;
- resource/token use.

Do not prematurely reduce performance to one score.

## 6. Controlled benchmark mode

Later NightShift can clone one Task across combinations.

Example:

```text
same repository base SHA
same task prompt
same validation
different Agent/Model
```

Each combination must run in its own isolated worktree.

This enables true matrix comparison.

## 7. V1 auto-routing

Not implemented.

`Auto` uses configured defaults.

## 8. Future routing

Only after enough evidence:

```text
task features/history
→ recommend Agent/Model
```

User must be able to override.

## 9. Privacy

Telemetry is local by default.

NightShift must not upload benchmark data unless an explicit future feature says so.

## 10. Dashboard timing

A polished Benchmarks primary nav item is not V1.

Initial benchmark information can live in:
- Run detail;
- Settings/diagnostics;
- later dedicated analytics view.
