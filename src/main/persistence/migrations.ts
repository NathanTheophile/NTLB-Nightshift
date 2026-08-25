export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'workspace_planner_and_settings',
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        is_git INTEGER NOT NULL CHECK (is_git IN (0, 1)),
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        prompt TEXT NOT NULL,
        title TEXT NOT NULL,
        requested_agent_id TEXT,
        requested_model_id TEXT,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 99),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'blocked', 'cancelled')),
        visible_in_planner INTEGER NOT NULL DEFAULT 1 CHECK (visible_in_planner IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX tasks_planner_queue_idx
        ON tasks(workspace_id, status, priority, created_at);

      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'execution_conversation_and_catalog_foundations',
    sql: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        resolved_agent_id TEXT NOT NULL,
        resolved_model_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'running', 'completed', 'failed', 'blocked', 'cancel_requested', 'cancelled', 'timed_out')),
        base_sha TEXT,
        worktree_path TEXT,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        result_summary TEXT,
        failure_reason TEXT,
        validation_status TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX runs_task_history_idx ON runs(task_id, created_at);
      CREATE INDEX runs_workspace_history_idx ON runs(workspace_id, created_at);

      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        permission_profile TEXT NOT NULL CHECK (permission_profile IN ('read_only', 'workspace_write', 'isolated_write')),
        isolation_mode TEXT NOT NULL CHECK (isolation_mode IN ('direct_workspace', 'isolated_worktree')),
        external_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'starting', 'active', 'waiting_for_user', 'terminated', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE worker_events (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        role_or_type TEXT NOT NULL,
        content TEXT,
        payload_json TEXT NOT NULL,
        UNIQUE(worker_id, sequence)
      );

      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(chat_id, sequence)
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        fcc_launcher TEXT NOT NULL,
        installed INTEGER NOT NULL CHECK (installed IN (0, 1)),
        version TEXT,
        capabilities_json TEXT NOT NULL,
        last_validated_at TEXT
      );

      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        raw_model_ref TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'run_execution_evidence',
    sql: `
      ALTER TABLE runs ADD COLUMN external_session_id TEXT;
      ALTER TABLE runs ADD COLUMN final_head_sha TEXT;
      ALTER TABLE runs ADD COLUMN final_git_state TEXT;
    `,
  },
  {
    version: 4,
    name: 'worker_execution_scope',
    sql: `
      ALTER TABLE workers ADD COLUMN working_directory TEXT;
      ALTER TABLE workers ADD COLUMN base_sha TEXT;
      UPDATE workers SET working_directory = '' WHERE working_directory IS NULL;
    `,
  },
  {
    version: 5,
    name: 'planner_execution_modes',
    sql: `
      ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'single_agent'
        CHECK (execution_mode IN ('single_agent', 'sequential_batch', 'delegated_leader'));
      ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'single_agent'
        CHECK (execution_mode IN ('single_agent', 'sequential_batch', 'delegated_leader'));
      CREATE TABLE planner_batch_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        step_index INTEGER NOT NULL CHECK (step_index >= 0),
        prompt TEXT NOT NULL,
        UNIQUE(task_id, step_index)
      );
      CREATE TABLE run_batch_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        step_index INTEGER NOT NULL CHECK (step_index >= 0),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
        started_at TEXT,
        finished_at TEXT,
        external_session_id TEXT,
        result_summary TEXT,
        failure_reason TEXT,
        UNIQUE(run_id, step_index)
      );
      CREATE INDEX planner_batch_steps_task_idx ON planner_batch_steps(task_id, step_index);
      CREATE INDEX run_batch_steps_run_idx ON run_batch_steps(run_id, step_index);
    `,
  },
  {
    version: 6,
    name: 'run_candidate_publication_and_follow_up_provenance',
    sql: `
      ALTER TABLE runs ADD COLUMN source_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT;
      ALTER TABLE runs ADD COLUMN follow_up_prompt TEXT;
      ALTER TABLE runs ADD COLUMN candidate_branch_name TEXT;
      ALTER TABLE runs ADD COLUMN candidate_commit_sha TEXT;
      ALTER TABLE runs ADD COLUMN candidate_remote_name TEXT;
      ALTER TABLE runs ADD COLUMN candidate_publish_state TEXT NOT NULL DEFAULT 'not_published'
        CHECK (candidate_publish_state IN ('not_published', 'publishing', 'published', 'failed'));
      ALTER TABLE runs ADD COLUMN candidate_published_at TEXT;
      ALTER TABLE runs ADD COLUMN candidate_failure_reason TEXT;
      CREATE INDEX runs_source_run_idx ON runs(source_run_id);
    `,
  },
  {
    version: 7,
    name: 'run_event_stream_pagination_index',
    sql: 'CREATE INDEX run_events_stream_page_idx ON run_events(run_id, event_type, sequence);',
  },
  {
    version: 8,
    name: 'run_validation_evidence_and_restart_recovery',
    sql: `
      CREATE TABLE run_validation_commands (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        profile_id TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'interrupted')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        output TEXT NOT NULL DEFAULT '',
        output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
        UNIQUE(run_id, sequence)
      );
      CREATE INDEX run_validation_commands_run_idx ON run_validation_commands(run_id, sequence);
    `,
  },
  {
    version: 9,
    name: 'immutable_run_integration_reviews',
    sql: `
      CREATE TABLE run_integration_reviews (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
        candidate_sha TEXT NOT NULL,
        target_dev_sha TEXT NOT NULL,
        reviewer_agent_id TEXT NOT NULL,
        reviewer_model_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'NEEDS_ATTENTION')),
        summary TEXT NOT NULL,
        findings TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        stale_at TEXT,
        stale_reason TEXT,
        integration_status TEXT NOT NULL DEFAULT 'not_started' CHECK (integration_status IN ('not_started', 'integrating', 'integrated', 'needs_attention', 'rejected')),
        integration_commit_sha TEXT,
        integration_validation TEXT,
        integration_failure_reason TEXT,
        integrated_at TEXT
      );
      CREATE INDEX run_integration_reviews_run_idx ON run_integration_reviews(run_id, created_at DESC);
    `,
  },
];
