# 13 — Security and Process Model

## 1. Threat model

NightShift combines:
- local filesystem access;
- Git operations;
- external coding-agent processes;
- FCC;
- future remote web content;
- configurable executable launchers.

Security boundaries must be explicit.

## 2. Electron renderer

Renderer must not receive unrestricted Node access.

Use:
- context isolation;
- sandbox where practical;
- narrow typed preload APIs;
- CSP;
- validated IPC.

## 3. Filesystem

Renderer requests workspace-relative operations.

Main process:
- resolves path;
- confirms it remains inside Workspace root;
- rejects traversal/outside access.

Explicit user-selected paths can be added to trusted configuration through controlled dialogs.

## 4. External processes

NightShift launches only:
- detected FCC launchers;
- configured Terminal/IDE/apps;
- project validation commands through controlled runtime policies.

Avoid generic renderer-to-shell IPC.

## 5. Process ownership

Track every child/process tree NightShift creates.

Cancellation must target owned processes only.

## 6. FCC

FCC server is local infrastructure.

NightShift should:
- verify endpoint;
- respect FCC auth if enabled;
- not log secrets;
- not overwrite unrelated user FCC config without explicit action.

## 7. Agent permissions

Permissions are part of execution specs.

Workers:
- configurable.

Planner:
- controlled unattended profile;
- isolated write scope;
- no destructive shared-Git actions.

## 8. Remote GPT

When implemented:
- separate unprivileged `WebContentsView`;
- no NightShift preload bridge;
- no Node integration;
- no filesystem privilege;
- persistent browser session partition only.

## 9. Application launchers

User-configured launcher commands are privileged configuration.

Store safely and do not allow remote content to trigger them.

## 10. Secrets

Provider credentials remain owned by FCC where possible.

NightShift should not duplicate them.

## 11. Logs

Logs may contain:
- code;
- file paths;
- prompts;
- tool output.

Treat local logs as sensitive project data.

Provide retention controls later.

## 12. Unattended operation

Before claiming reliable “overnight” operation, NightShift must have:
- hard Run timeout;
- process cancellation;
- isolation;
- queue continuation after failure;
- persistent state;
- crash recovery policy;
- no interactive login prompts;
- validated agent/model combinations.
