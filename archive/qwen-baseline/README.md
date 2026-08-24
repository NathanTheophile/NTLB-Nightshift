# Qwen Baseline Archive

Qwen is intentionally not an active NightShift V2 dependency.

The earlier Qwen/FCC/NVIDIA work remains historically useful because it established:
- coding-agent harness quality matters independently of model;
- large tool-schema context can dominate token/context cost;
- isolated worktrees are valuable;
- automated workers need hard runtime limits;
- realistic tasks are better benchmarks than synthetic marker edits.

Do not import old Qwen routing/worker policies into V2 product code unless a new explicit decision is made.

The previous Master Pack should be kept separately as a historical artifact if desired.
