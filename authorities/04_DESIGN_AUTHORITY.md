# 04 — Design Authority

## 1. Current visual references

### Primary
- `Planner_Mockup_CURRENT.png`
- `Worker_Conversation_Mockup_CURRENT.png`

### Secondary / legacy composition
- `Workspace_Mockup_LEGACY_COMPOSITION_REFERENCE.png`

The legacy composition image is useful for:
- upper application chrome;
- project tabs;
- left/center/right proportions;
- right explorer treatment;
- quick-tool placement.

Its older navigation labels are superseded.

## 2. Visual language

NightShift should preserve the authored direction:
- dark desktop workspace;
- deep purple/violet chrome;
- restrained purple accents;
- dark central content canvas;
- thin separators;
- subtle rounded controls;
- low-noise hierarchy;
- compact professional density;
- custom desktop-tool feeling rather than web-dashboard feeling.

## 3. Anti-patterns

Do not:
- replace with generic SaaS dashboard;
- use oversized cards everywhere;
- use bright gradients unrelated to reference;
- ship stock Material/Bootstrap styling;
- turn every action into a colorful pill;
- bake complete panels/text into raster images.

## 4. Asset strategy

Illustrator exports should be used for:
- NightShift logo/mark;
- custom icons;
- specialized vector ornaments.

CSS/HTML should implement:
- panels;
- borders;
- tabs;
- text;
- hover;
- layout;
- spacing;
- lists;
- input surfaces.

Prefer SVG for vector assets.

## 5. Desktop target

Windows-first.

Primary composition target:
- 1920×1080.

Must remain usable at:
- 1366×768 or similar minimum laptop desktop.

Mobile layout is not a V1 requirement.

## 6. Interaction density

NightShift is a developer tool. Favor information density over marketing whitespace.

Long Task/Worker titles should ellipsize gracefully.

Lists should support scrolling without shifting global chrome.

## 7. Worker conversation design

The mockup's main principle is authoritative:
- conversation transcript in central area;
- selected Worker visible in sidebar;
- agent/model controls near composer;
- agent/model locked once Worker is established;
- central title indicates current Worker.

The final implementation may refine bubble shapes and metadata, but not replace the conversation mental model with a raw terminal-only product.

## 8. Planner design

The mockup's main principle is authoritative:
- compact task rows;
- metadata line;
- status at right;
- relative time/duration;
- creation composer at bottom;
- Agent / Model / Priority controls;
- completed tasks persist visibly until archived.

## 9. Runs

Runs should visually reuse Planner/task language so the user understands the link.

Avoid inventing a completely separate visual system.
