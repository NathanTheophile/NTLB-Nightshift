# 15 — Decision Register and Open Questions

## Locked decisions — 2026-08-24

### D01 Product positioning
**Decision:** General project hub; overnight automation is a major capability, not the entire product.

### D02 Primary navigation
**Decision:** Planner / Runs / Workers / Chats / GPT.

### D03 Worker identity
**Decision:** One coding Agent + one Model locked per Worker conversation.

### D04 Worker permissions
**Decision:** Configurable per Worker.

### D05 Task/Run cardinality
**Decision:** One Run per Task attempt. Retry creates a new Run.

### D06 Planner scheduling
**Decision:** One top-level Run at a time. Priority 1 highest; FIFO within same priority.

### D07 Auto
**Decision:** Agent Auto and Model Auto allowed. Initially resolve to configured defaults, not intelligent routing.

### D08 FCC
**Decision:** FCC mandatory central V1 gateway.

Implementation note:
NightShift still wraps FCC behind one internal service boundary so domain logic remains clean. This does not imply a second gateway will be built.

### D09 Coding agents
**Decision:** Detect all FCC-supported installed coding agents instead of hardcoding only Codex/Claude.

Execution remains capability/validation gated.

### D10 Qwen
**Decision:** Removed from active product. Retained only as historical benchmark/archive.

### D11 Planner Git isolation
**Decision:** Automated write-capable Runs always use isolated Git worktrees.

### D12 Worker Git isolation
**Decision:** Configurable: direct Workspace or isolated.

### D13 Chats
**Decision:** NightShift-native lightweight Chats use FCC with a selected lightweight model and read-only project context.

### D14 GPT
**Decision:** Retained, but implemented after core Planner/Run/Worker vertical slice.

### D15 Development order
**Decision:** Hybrid.
1. validate FCC CLI;
2. build thin visual shell quickly;
3. immediately build real vertical slice;
4. then expand horizontally.

### D16 First adapter
**Decision:** Determined by CLI benchmark/validation, not preference.

### D17 Telemetry
**Decision:** Every Run records benchmark-relevant telemetry.

### D18 Paid APIs
**Decision:** Out of official V1 scope.

### D19 Persistence
**Decision:** SQLite from start.

### D20 Automation surface name
**Decision:** `Runs`.

No additional `Shift` domain object is introduced now.

## Important derived decisions

### D21 UI organized by work type
No Claude/Codex primary tabs.

### D22 Agent detection ≠ Planner support
Every detected FCC agent may appear, but Planner requires validated automation capability.

### D23 Model compatibility must be proven
NightShift does not promise arbitrary agent × model combinations.

### D24 No-Git automated writes
A non-Git Workspace cannot run write-capable Planner automation in V1.

## Open technical questions that do not invalidate product direction

### O01 FCC model override
How does each coding agent reliably receive a specific FCC model at process start without mutable global config or brittle UI automation?

### O02 Machine-readable output
Which agents expose stable structured/headless event formats?

### O03 Resume
Which Worker agents can resume across NightShift restarts?

### O04 Process cancellation
Best process-tree cancellation implementation per harness on Windows?

### O05 Agent discovery
Can FCC expose launcher metadata directly, or should NightShift combine command probing + maintained descriptors?

### O06 Dirty repository base
What exact clean base does Planner use when user's main Workspace is dirty?

### O07 Candidate/commit semantics
Should successful Runs always end in a local commit?

### O08 Validation contract
How should project-specific validation commands be configured?

### O09 Worktree retention
When are successful/failed worktrees auto-cleaned?

### O10 Chat runtime details
Which FCC protocol endpoint and model provide the best lightweight Chat path?

### O11 SQLite library
Which Electron-compatible SQLite binding gives the best packaging reliability?

### O12 Structured Worker UI
For each harness, can we render normalized conversation events or must we fall back to PTY terminal mode?

### O13 FCC settings
How much of FCC Admin should NightShift reproduce versus link/open?

### O14 Crash recovery
How does NightShift reconcile a Run/process/worktree after app crash/restart?

## Questions explicitly deferred to evidence

- best Agent;
- best Model;
- best Agent × Model pair;
- whether intelligent auto-routing is useful;
- whether top-level Planner parallelism improves throughput;
- whether Qwen ever deserves reintroduction.
