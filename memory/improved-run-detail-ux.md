---
name: improved-run-detail-ux
description: Enhanced RunDetailCard with concise human-readable execution summary
metadata:
  type: project
---

Added a compact execution summary near the top of RunDetailCard showing:
- Final/current Run status
- Task title
- Agent and model
- Elapsed duration from startedAt/finishedAt
- Overall validation status and concise validation command summary
- Candidate publication state, branch and short SHA when available
- Reviewer verdict and integration status when available

The summary is displayed in a grid format with labels and values, keeping the existing Prompt, Changes, Activity and Raw Protocol tabs intact. Raw data remains accessible.

Implementation details:
- Used useEffect with cleanup to handle duration updates for running processes
- Created helper functions for formatting duration and validation summaries
- Added proper TypeScript typing to avoid impure function calls in render
- Maintained existing functionality while enhancing UX
- Added CSS styles for the new summary component

Related files:
- src/renderer/src/components/RunDetailCard.tsx - Main implementation
- src/renderer/src/styles.css - Added styles for .run-execution-summary and related classes