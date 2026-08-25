# 01 — LUNA LEADER PROTOCOL

## 1. Transport

Leader calls go directly through the local FCC gateway.

Preferred V1 route:

```text
POST <fcc-endpoint>/v1/messages
```

The current NightShift gateway already queries:

```text
GET <fcc-endpoint>/v1/models?view=messages
```

Therefore the Leader model must be selected from the FCC catalog compatible with the Messages view.

The HTTP implementation should be owned by a dedicated service, e.g.:

```ts
interface LeaderClient {
  decide(request: LeaderRequest, signal: AbortSignal): Promise<LeaderDecision>;
}
```

Do not launch Claude Code or Codex merely to obtain a Leader decision unless direct FCC Messages routing proves incompatible with the connected Luna model.

## 2. Luna model resolution

The user already has the OpenAI/ChatGPT provider connected in FCC.

Resolution rules:

1. read FCC's live model catalog;
2. resolve the configured Leader model;
3. default intent is `Luna`;
4. require a unique routable OpenAI/ChatGPT Luna match;
5. persist the exact FCC model ID on the Run;
6. if no unique match exists, fail preflight with a clear actionable error.

Do not invent or hardcode a model ID that is not returned by FCC.

A later UI can expose Leader model selection. The first vertical slice may use a resolver/config setting without redesigning Planner.

## 3. Request shape

The Leader receives **bounded operational evidence**, not private chain-of-thought from Workers.

Conceptual schema:

```ts
interface LeaderRequest {
  protocolVersion: 1;
  runId: string;
  phase: 'initial' | 'post_attempt';
  task: { title: string; prompt: string };
  worker: { agentId: string; modelId: string };
  budget: {
    attemptIndex: number;
    maxAttempts: number;
    remainingAttempts: number;
  };
  attempt?: {
    index: number;
    workerResultSummary: string | null;
    workerFailureReason: string | null;
  };
  evidence: {
    gitStatus: string;
    changedFiles: string[];
    diff: string;
    diffTruncated: boolean;
    validationStatus: 'passed' | 'failed' | 'not_configured' | 'interrupted';
    validationCommands: Array<{
      command: string;
      status: string;
      exitCode: number | null;
      output: string;
      outputTruncated: boolean;
    }>;
    priorAttemptSummaries: string[];
  };
}
```

Initial phase may have empty implementation evidence.

## 4. Evidence bounds

Recommended hard bounds for V1:

- full Leader request JSON: <= 192 KiB;
- diff portion: <= 96 KiB;
- validation output total: <= 64 KiB;
- prior attempt summaries: <= 4 KiB each;
- changed-file list: <= 500 entries.

When evidence exceeds the bound:

- preserve deterministic truncation metadata;
- prefer changed-file names + diff summary + validation failures;
- include the tail/relevant error output for failed commands;
- never silently claim evidence is complete.

Reuse existing bounded Run review/validation utilities where possible.

## 5. Decision shape

The Leader must return strict JSON only.

```ts
type LeaderDecision =
  | {
      protocolVersion: 1;
      action: 'WORK';
      instruction: string;
      summary: string;
    }
  | {
      protocolVersion: 1;
      action: 'DONE';
      summary: string;
    }
  | {
      protocolVersion: 1;
      action: 'BLOCKED';
      summary: string;
      blocker: string;
    };
```

`summary` is an operational explanation suitable for the Run UI. It is not hidden reasoning.

## 6. Decision invariants

### WORK
Requires:
- non-empty `instruction`;
- remaining attempt budget > 0.

NightShift creates the next Worker attempt automatically.

### DONE
Accepted only if deterministic validation is `passed`.

If validation is not passed, `DONE` is rejected and the Leader is asked for a corrective decision using the same evidence plus an explicit invariant violation message.

### BLOCKED
Immediately terminates the autonomous Run as `blocked`.

## 7. Malformed Leader output

Strict parsing:

1. parse JSON;
2. validate exact schema;
3. on failure, make **one** protocol-repair request to Luna containing the invalid response and required schema;
4. if repair also fails, block with `leader_protocol_error`.

Do not regex-guess a decision from arbitrary prose.

## 8. Leader system instruction

```text
You are NightShift's Delegated Leader.

You do not edit code directly. You decide what the coding Worker should do next based on the user's task and bounded implementation evidence.

Return exactly one JSON object matching the provided protocol schema.

Choose:
- WORK when another coding attempt is required;
- DONE only when the task is implemented and deterministic validation passed;
- BLOCKED when continuing autonomously is not reasonable.

For WORK, give one concrete implementation/correction instruction to the Worker. The Worker can inspect the repository itself.

Do not include chain-of-thought. Put only a concise operational summary in `summary`.
```

## 9. Initial decision

At the start of an autonomous Run, Luna receives the original Task, selected Worker pair, attempt budget, and minimal repository metadata. Normally it returns `WORK` with the first implementation instruction.

## 10. Post-attempt decision

After every Worker attempt, Luna receives Task + Worker result + Git diff/evidence + deterministic validation output + attempt history + remaining budget.

This replaces human-written Follow-ups.
