# 05 — AUTONOMY ACCEPTANCE TESTS

These tests are the contract. Implementation is incomplete until they pass.

## A. Required deterministic test: self-correction

Use fake Leader + fake Worker adapter + temporary Git fixture.

```text
Task starts in delegated_leader
Leader initial → WORK("implement")
Attempt 0 Worker writes implementation that fails typecheck
NightShift validation → failed
Leader receives failed validation → WORK("fix the type error")
Attempt 1 Worker corrects the same worktree
NightShift validation → passed
Leader → DONE
Run → completed
```

Assertions:

- exactly one Run;
- exactly one worktree;
- two `run_attempts`;
- fresh Worker invocation per attempt;
- attempt 1 sees filesystem changes from attempt 0;
- no `createFollowUp`;
- no intermediate Candidate publication;
- no push;
- final Run validation passed;
- terminal Run completed.

## B. DONE cannot override failed validation

Leader returns `DONE` after failed validation.

Expected:

- NightShift refuses completion;
- Leader gets invariant-correction request;
- next valid decision must be WORK or BLOCKED while budget remains.

## C. Green validation can still receive WORK

Validation passes but Leader returns `WORK`.

Expected: another attempt in same worktree; completion waits for later DONE.

## D. Attempt budget

Leader keeps returning WORK.

At max attempts:

- no attempt N+1;
- Run → blocked;
- worktree preserved;
- clear budget-exhausted reason.

## E. Malformed Leader response

First invalid JSON/schema → one repair request. Second invalid → blocked with `leader_protocol_error`.

## F. FCC/Luna unavailable

No unique Luna model or FCC unavailable → no Worker launch; Run blocked in preflight with actionable evidence.

## G. Worker process failure

Persist attempt failure and call Leader with failure evidence when safe. Leader may recover with WORK or stop with BLOCKED.

## H. Cancellation

Cancel during Leader request, Worker process, and validation process. No future attempt; Run cancelled; evidence/worktree preserved.

## I. Whole-Run timeout

Attempts do not reset timeout. Current phase stops; no future attempt; Run timed_out; evidence preserved.

## J. Restart recovery

Nonterminal delegated Run found after restart → blocked with interruption reason; worktree retained; no blind auto-resume.

## K. Legacy isolation

Existing Single Agent, Sequential Batch, Candidate, manual Follow-up, Review/Integration and concurrency tests continue to pass unless explicitly superseded.

## L. Manual real-world dogfood

```text
Select Delegated Leader
→ queue bounded coding task
→ Luna resolves through FCC
→ Worker runs
→ if imperfect, Luna autonomously issues correction
→ user never clicks Follow-up or writes another prompt
→ success only on validation PASS + Luna DONE
```
