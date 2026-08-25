---
name: planner-ui-improvements
description: Improved Planner composer configuration fields for clarity with labels, two-row layout, wider selects, and helper text.
metadata:
  type: project
---

Updated PlannerView.tsx and styles.css to:

- Add visible labels above each dropdown: Agent, Modèle, Mode d’exécution, Priorité, Runs concurrents
- Reorganize layout into two rows:
  Row 1: Agent | Modèle | Mode d’exécution
  Row 2: Priorité | Runs concurrents
- Increased width of selects, especially Model field to accommodate long model names
- Added helper text:
  - Priorité: `1 = la plus haute`
  - Runs concurrents: `nombre maximal de tâches Planner exécutées simultanément`
- Maintained existing Planner behavior and layout consistency
- Made responsive, avoiding five narrow fields on one row
- Preserved Sequential Batch editor and prompt composer layout

Changes:
1. src/renderer/src/components/PlannerView.tsx: Wrapped selects in label elements with visible spans, grouped into two rows using planner-fields-row divs.
2. src/renderer/src/styles.css: Rewrote .planner-fields to use grid-template-rows: repeat(2, auto); added .planner-fields-row with appropriate grid-template-columns for each row; styled label spans to be visible; added .helper-text styling.

All existing functionality preserved.