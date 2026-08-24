# 11 — Data Model and SQLite

## 1. Decision

Use SQLite from the beginning.

NightShift now has durable relational entities:
- Workspaces;
- Tasks;
- Runs;
- Worker Conversations;
- Worker Events/Messages;
- Chats;
- Chat Messages;
- Agents;
- Models/cache metadata;
- benchmark metrics;
- settings.

JSON-only persistence would become awkward quickly.

## 2. Database ownership

SQLite file belongs to NightShift application data, not the project repository.

Suggested location:
- Electron `app.getPath('userData')`.

Workspace-specific data references Workspace IDs and filesystem paths.

## 3. Core tables

### workspaces

```text
id
path
display_name
created_at
last_opened_at
is_git
settings_json
```

### tasks

```text
id
workspace_id
prompt
title
requested_agent_id nullable/auto
requested_model_id nullable/auto
priority
status
visible_in_planner
created_at
updated_at
```

### runs

```text
id
task_id
workspace_id
resolved_agent_id
resolved_model_id
status
base_sha
worktree_path
started_at
finished_at
exit_code
result_summary
failure_reason
validation_status
created_at
```

### run_events

```text
id
run_id
sequence
timestamp
event_type
payload_json
```

### workers

```text
id
workspace_id
title
agent_id
model_id
permission_profile
isolation_mode
external_session_id
status
created_at
updated_at
```

### worker_events

```text
id
worker_id
sequence
timestamp
role_or_type
content
payload_json
```

### chats

```text
id
workspace_id
title
model_id
created_at
updated_at
```

### chat_messages

```text
id
chat_id
sequence
timestamp
role
content
metadata_json
```

### agents

Local discovery cache:
```text
id
display_name
fcc_launcher
installed
version
capabilities_json
last_validated_at
```

### models

FCC catalog cache:
```text
id
provider_id
display_name
raw_model_ref
metadata_json
last_seen_at
```

## 4. IDs

Use stable UUID/ULID-style IDs.

User-visible Run numbers can be derived/displayed separately.

## 5. Event model

Runs and Workers should store append-only events where possible.

This supports:
- streaming UI;
- replay;
- diagnostics;
- normalized agent output;
- future benchmark extraction.

## 6. Migrations

Schema versioning is mandatory.

Never mutate production schema ad hoc.

Use ordered migrations.

## 7. Deletion semantics

### Archive Task
Soft/hide only.

### Delete Worker/Chat
Can eventually be hard delete after confirmation, but consider linked files/worktrees/session references.

### Run
Historical evidence should be difficult to accidentally delete.

## 8. Secrets

Do not store provider API keys in ordinary SQLite settings.

FCC owns provider credentials/configuration.

NightShift stores only what it needs to connect to local FCC safely.

## 9. Log size

Raw terminal/process logs can grow large.

Consider:
- event table for normalized data;
- file-backed raw logs with DB reference;
- retention policy.

Exact implementation open.

## 10. Benchmark fields

Do not create a separate benchmark-only execution database.

Runs naturally provide benchmark facts.

Benchmark views query ordinary telemetry.
