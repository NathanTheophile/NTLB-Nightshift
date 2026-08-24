# 10 — Git Isolation and Safety

## 1. Core split

### Planner / Runs
Mandatory isolated worktree for write-capable automation.

### Workers
User-selectable:
- direct Workspace;
- isolated worktree.

This is a deliberate distinction between unattended automation and supervised interaction.

## 2. Why automated Runs are isolated

Unattended tasks must not:
- overwrite the user's dirty working tree;
- interleave changes from unrelated Tasks;
- make review impossible;
- destroy uncommitted work.

Isolation gives each Run a stable evidence boundary.

## 3. Run Git record

Every write-capable Run should record:
- repository root;
- base SHA;
- source branch/ref if relevant;
- worktree path;
- final HEAD if commits exist;
- changed files;
- diff summary;
- validation result.

## 4. Worker direct mode

Direct Workers may operate on a dirty tree.

NightShift must not assume the tree is clean.

The external coding agent may know how to limit itself to its own changes, but NightShift still records:
- status at Worker start;
- subsequent relevant Git status where practical.

## 5. Forbidden unattended operations

Planner agents must not be granted unrestricted permission to:
- force-push;
- destructive reset;
- clean unknown files;
- delete branches;
- rewrite shared history;
- deploy;
- merge protected branches.

Any future exception requires explicit policy.

## 6. Commit policy

Not fully locked.

Possible future Run result:
- uncommitted diff in isolated worktree;
- local candidate commit;
- multiple commits.

Initial vertical slice may allow agent-native behavior while recording final state.

Before serious overnight use, candidate semantics must be standardized.

## 7. Push policy

No automatic push in initial V1.

NightShift can later offer explicit delivery actions.

## 8. Worktree cleanup

Never destroy a failed/blocked worktree before:
- logs persisted;
- Git state persisted;
- user policy says cleanup is safe.

Successful worktree cleanup policy remains open.

## 9. Dirty base question

Still open:
- whether automated Runs base directly on current branch HEAD;
- whether NightShift maintains a clean mirror/base checkout;
- how to handle branch changes while queue is running.

This must be solved before long unattended production runs, but does not block the first controlled vertical slice.
