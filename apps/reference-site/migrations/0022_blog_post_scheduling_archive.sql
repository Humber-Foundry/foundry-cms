-- Durable blog-post scheduling, execution, archive, and restore state.
CREATE TABLE blog_post_collection_states (
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  collection_state TEXT NOT NULL CHECK (
    collection_state IN ('active', 'archiving', 'archived')
  ),
  selected_post_revision_id TEXT,
  archive_request_id TEXT,
  restore_request_id TEXT,
  restore_selected_post_revision_id TEXT,
  restore_actor_id TEXT,
  archive_publication_id TEXT,
  withdrawal_workspace_id TEXT,
  withdrawal_content_revision INTEGER,
  withdrawal_created_by TEXT,
  archived_by TEXT,
  archive_reason TEXT NOT NULL DEFAULT 'editor_requested',
  previous_schedule_id TEXT,
  previous_live_revision_id TEXT,
  archived_at TEXT,
  workflow_state TEXT NOT NULL DEFAULT 'editing' CHECK (
    workflow_state IN (
      'editing', 'approval_required', 'approved', 'scheduled',
      'executing', 'failed', 'superseded'
    )
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, post_id),
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id),
  FOREIGN KEY (selected_post_revision_id)
    REFERENCES blog_post_revisions(revision_id)
);

CREATE TABLE blog_post_schedules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  post_revision_id TEXT NOT NULL REFERENCES blog_post_revisions(revision_id),
  approval_id TEXT NOT NULL REFERENCES content_approvals(id),
  approval_fingerprint TEXT NOT NULL,
  authority_post_revision_id TEXT NOT NULL,
  authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
  local_date_time TEXT NOT NULL,
  iana_time_zone TEXT NOT NULL,
  utc_offset_choice TEXT NOT NULL,
  execute_at_utc TEXT NOT NULL,
  time_zone_database_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  activation_audit_id TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'active', 'claimed', 'cancelled', 'blocked',
      'failed', 'unknown', 'completed'
    )
  ),
  detail TEXT,
  idempotency_key TEXT NOT NULL,
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id),
  FOREIGN KEY (workspace_id, content_revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE UNIQUE INDEX blog_post_schedules_one_active
ON blog_post_schedules (site_id, post_id)
WHERE state = 'active';

CREATE TABLE blog_post_schedule_proposals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  content_revision INTEGER NOT NULL,
  post_revision_id TEXT NOT NULL REFERENCES blog_post_revisions(revision_id),
  authority_version INTEGER NOT NULL CHECK (authority_version >= 1),
  local_date_time TEXT NOT NULL,
  iana_time_zone TEXT NOT NULL,
  utc_offset_choice TEXT NOT NULL,
  execute_at_utc TEXT NOT NULL,
  time_zone_database_version TEXT NOT NULL,
  created_by TEXT NOT NULL,
  proposal_audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  UNIQUE (site_id, post_id, idempotency_key),
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id),
  FOREIGN KEY (workspace_id, content_revision)
    REFERENCES content_revisions(workspace_id, revision)
);

CREATE TABLE blog_post_schedule_cancellations (
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL REFERENCES blog_post_schedules(id),
  actor_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (site_id, post_id, request_id),
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id)
);

CREATE TABLE blog_post_schedule_executions (
  execution_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES blog_post_schedules(id),
  scheduled_instant TEXT NOT NULL,
  publication_idempotency_key TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  attempt_actor_id TEXT NOT NULL,
  attempt_request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('claimed', 'blocked', 'failed', 'unknown', 'completed')
  ),
  detail TEXT,
  claimed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  outcome_request_id TEXT,
  outcome_response_json TEXT,
  UNIQUE (schedule_id, scheduled_instant)
);

ALTER TABLE content_publications
ADD COLUMN schedule_execution_id TEXT
  REFERENCES blog_post_schedule_executions(execution_id);

CREATE TABLE blog_post_schedule_publication_attributions (
  schedule_id TEXT PRIMARY KEY REFERENCES blog_post_schedules(id),
  publication_idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TRIGGER blog_post_schedule_attribution_rejects_existing_publication
BEFORE INSERT ON blog_post_schedule_publication_attributions
WHEN EXISTS (
  SELECT 1
  FROM content_publications AS publication
  WHERE publication.idempotency_key = NEW.publication_idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_publication_ownership_conflict');
END;

CREATE TRIGGER content_publications_require_schedule_ownership
BEFORE INSERT ON content_publications
WHEN (
  EXISTS (
    SELECT 1
    FROM blog_post_schedule_publication_attributions AS attribution
    WHERE attribution.publication_idempotency_key = NEW.idempotency_key
  )
  OR NEW.schedule_execution_id IS NOT NULL
) AND NOT EXISTS (
  SELECT 1
  FROM blog_post_schedule_publication_attributions AS attribution
  JOIN blog_post_schedule_executions AS execution
    ON execution.schedule_id = attribution.schedule_id
   AND execution.execution_id = NEW.schedule_execution_id
  JOIN blog_post_schedules AS schedule
    ON schedule.id = execution.schedule_id
  JOIN blog_post_schedule_publication_reservations AS reservation
    ON reservation.execution_id = execution.execution_id
   AND reservation.publication_idempotency_key =
       attribution.publication_idempotency_key
  WHERE attribution.publication_idempotency_key = NEW.idempotency_key
    AND reservation.state = 'reserved'
    AND reservation.attempt = execution.attempt
    AND reservation.lease_token = execution.lease_token
    AND execution.state = 'claimed'
    AND execution.lease_expires_at > NEW.requested_at
    AND schedule.workspace_id = NEW.workspace_id
    AND schedule.content_revision = NEW.revision
    AND schedule.approval_id = NEW.approval_id
    AND schedule.approval_fingerprint = NEW.fingerprint
    AND NEW.requested_by = CASE
      WHEN execution.attempt_actor_id = 'system:scheduler'
        THEN schedule.activated_by
      ELSE execution.attempt_actor_id
    END
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_publication_ownership_required');
END;

CREATE TRIGGER content_publications_preserve_schedule_ownership
BEFORE UPDATE OF schedule_execution_id, idempotency_key
ON content_publications
WHEN NEW.schedule_execution_id IS NOT OLD.schedule_execution_id
  OR NEW.idempotency_key <> OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_publication_ownership_immutable');
END;

CREATE TRIGGER blog_post_schedule_activation_rejects_in_flight_execution
BEFORE INSERT ON blog_post_schedules
WHEN EXISTS (
  SELECT 1
  FROM blog_post_schedules AS schedule
  JOIN blog_post_schedule_executions AS execution
    ON execution.schedule_id = schedule.id
  WHERE schedule.site_id = NEW.site_id
    AND schedule.post_id = NEW.post_id
    AND schedule.state IN ('claimed', 'unknown')
    AND execution.state IN ('claimed', 'unknown')
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_in_flight');
END;

CREATE TRIGGER blog_post_archive_insert_rejects_unresolved_execution
BEFORE INSERT ON blog_post_collection_states
WHEN NEW.collection_state IN ('archiving', 'archived')
  AND EXISTS (
    SELECT 1
    FROM blog_post_schedules AS schedule
    JOIN blog_post_schedule_executions AS execution
      ON execution.schedule_id = schedule.id
    WHERE schedule.site_id = NEW.site_id
      AND schedule.post_id = NEW.post_id
      AND schedule.state IN ('claimed', 'unknown')
      AND execution.state IN ('claimed', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'blog_post_archive_execution_unresolved');
END;

CREATE TRIGGER blog_post_archive_update_rejects_unresolved_execution
BEFORE UPDATE OF collection_state ON blog_post_collection_states
WHEN NEW.collection_state IN ('archiving', 'archived')
  AND OLD.collection_state = 'active'
  AND EXISTS (
    SELECT 1
    FROM blog_post_schedules AS schedule
    JOIN blog_post_schedule_executions AS execution
      ON execution.schedule_id = schedule.id
    WHERE schedule.site_id = NEW.site_id
      AND schedule.post_id = NEW.post_id
      AND schedule.state IN ('claimed', 'unknown')
      AND execution.state IN ('claimed', 'unknown')
  )
BEGIN
  SELECT RAISE(ABORT, 'blog_post_archive_execution_unresolved');
END;

CREATE TRIGGER blog_post_live_archive_insert_serializes_withdrawals
BEFORE INSERT ON blog_post_collection_states
WHEN NEW.collection_state = 'archiving'
  AND NEW.previous_live_revision_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM blog_post_collection_states AS withdrawal
    WHERE withdrawal.site_id = NEW.site_id
      AND withdrawal.post_id <> NEW.post_id
      AND withdrawal.collection_state = 'archiving'
      AND withdrawal.previous_live_revision_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'blog_post_live_withdrawal_in_progress');
END;

CREATE TRIGGER blog_post_live_archive_update_serializes_withdrawals
BEFORE UPDATE OF collection_state ON blog_post_collection_states
WHEN NEW.collection_state = 'archiving'
  AND NEW.previous_live_revision_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM blog_post_collection_states AS withdrawal
    WHERE withdrawal.site_id = NEW.site_id
      AND withdrawal.post_id <> NEW.post_id
      AND withdrawal.collection_state = 'archiving'
      AND withdrawal.previous_live_revision_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'blog_post_live_withdrawal_in_progress');
END;

CREATE TRIGGER blog_post_archive_insert_advances_aggregate_version
AFTER INSERT ON blog_post_collection_states
WHEN NEW.collection_state IN ('archiving', 'archived')
BEGIN
  UPDATE blog_posts
  SET version = version + 1,
      updated_at = NEW.updated_at
  WHERE site_id = NEW.site_id AND post_id = NEW.post_id;
END;

CREATE TRIGGER blog_post_archive_update_advances_aggregate_version
AFTER UPDATE OF collection_state ON blog_post_collection_states
WHEN NEW.collection_state IN ('archiving', 'archived')
  AND NEW.collection_state <> OLD.collection_state
BEGIN
  UPDATE blog_posts
  SET version = version + 1,
      updated_at = NEW.updated_at
  WHERE site_id = NEW.site_id AND post_id = NEW.post_id;
END;

CREATE TABLE blog_post_schedule_execution_outcomes (
  site_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  execution_id TEXT NOT NULL
    REFERENCES blog_post_schedule_executions(execution_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('blocked', 'failed', 'unknown', 'completed')
  ),
  detail TEXT,
  response_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (site_id, outcome_id),
  UNIQUE (execution_id, attempt)
);

CREATE TABLE blog_post_schedule_execution_events (
  site_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  execution_id TEXT NOT NULL
    REFERENCES blog_post_schedule_executions(execution_id),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  from_state TEXT NOT NULL CHECK (
    from_state IN ('claimed', 'blocked', 'failed', 'unknown', 'completed')
  ),
  to_state TEXT NOT NULL CHECK (
    to_state IN ('claimed', 'blocked', 'failed', 'unknown', 'completed')
  ),
  detail TEXT,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (site_id, event_id)
);

CREATE TABLE blog_post_schedule_retry_receipts (
  site_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  execution_id TEXT NOT NULL
    REFERENCES blog_post_schedule_executions(execution_id),
  actor_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 2),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  response_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (site_id, request_id),
  UNIQUE (execution_id, attempt)
);

CREATE TABLE blog_post_schedule_publication_reservations (
  execution_id TEXT PRIMARY KEY
    REFERENCES blog_post_schedule_executions(execution_id),
  publication_idempotency_key TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'released')),
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE UNIQUE INDEX blog_post_schedule_one_publication_reservation
ON blog_post_schedule_publication_reservations ((1))
WHERE state = 'reserved';

CREATE TABLE blog_post_archive_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  selected_post_revision_id TEXT NOT NULL
    REFERENCES blog_post_revisions(revision_id),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('archiving', 'archived', 'restored')
  ),
  publication_id TEXT,
  archive_reason TEXT NOT NULL,
  previous_schedule_id TEXT,
  previous_live_revision_id TEXT,
  occurred_at TEXT NOT NULL,
  response_json TEXT,
  UNIQUE (site_id, post_id, request_id, outcome),
  FOREIGN KEY (site_id, post_id) REFERENCES blog_posts(site_id, post_id)
);

CREATE TABLE blog_post_restore_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  source_post_revision_id TEXT NOT NULL
    REFERENCES blog_post_revisions(revision_id),
  restored_workspace_id TEXT NOT NULL,
  restored_content_revision INTEGER NOT NULL,
  restored_post_revision_id TEXT NOT NULL
    REFERENCES blog_post_revisions(revision_id),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  response_json TEXT NOT NULL,
  UNIQUE (site_id, post_id, request_id)
);

CREATE TABLE blog_post_operation_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  post_id TEXT,
  actor_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  reason_code TEXT NOT NULL,
  before_state_json TEXT,
  after_state_json TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (site_id, command_type, request_id, outcome),
  UNIQUE (site_id, event_id)
);

CREATE TRIGGER blog_post_schedules_require_current_authority
BEFORE INSERT ON blog_post_schedules
WHEN NOT EXISTS (
  SELECT 1
  FROM blog_posts AS post
  JOIN content_approvals AS approval
    ON approval.id = NEW.approval_id
   AND approval.workspace_id = NEW.workspace_id
   AND approval.revision = NEW.content_revision
   AND approval.fingerprint = NEW.approval_fingerprint
  JOIN content_workspaces AS workspace
    ON workspace.workspace_id = NEW.workspace_id
   AND workspace.site_id = NEW.site_id
   AND workspace.current_revision = NEW.content_revision
  JOIN blog_post_revisions AS revision
    ON revision.revision_id = NEW.post_revision_id
   AND revision.site_id = NEW.site_id
   AND revision.post_id = NEW.post_id
   AND revision.workspace_id = NEW.workspace_id
   AND revision.content_revision = NEW.content_revision
  LEFT JOIN blog_post_collection_states AS collection
    ON collection.site_id = post.site_id
   AND collection.post_id = post.post_id
  WHERE post.site_id = NEW.site_id
    AND post.post_id = NEW.post_id
    AND COALESCE(collection.collection_state, 'active') = 'active'
    AND post.current_revision_id = NEW.authority_post_revision_id
    AND (
      revision.revision > post.current_revision
      OR revision.revision_id = post.current_revision_id
    )
    AND post.version = NEW.authority_version
    AND EXISTS (
      SELECT 1
      FROM json_each(approval.blog_post_artifacts_json) AS artifact
      WHERE json_extract(artifact.value, '$.postId') = NEW.post_id
        AND json_extract(artifact.value, '$.postRevisionId') =
            NEW.post_revision_id
        AND json_extract(artifact.value, '$.value') =
            revision.artifact_fingerprint
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_approval_invalidations
      WHERE approval_id = NEW.approval_id
    )
    AND approval.production_base = COALESCE((
      SELECT
        'git:' || publication.commit_sha ||
        '@content:' || publication_approval.content_hash
      FROM blog_publication_reconciliation_order AS publication_order
      JOIN content_publications AS publication
        ON publication.id = publication_order.publication_id
      JOIN content_approvals AS publication_approval
        ON publication_approval.id = publication.approval_id
      WHERE publication.status = 'verified-live'
        AND publication.commit_sha IS NOT NULL
      ORDER BY publication_order.sequence DESC
      LIMIT 1
    ), approval.production_base)
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_authority_stale');
END;

CREATE TRIGGER blog_post_schedule_claims_require_current_authority
BEFORE UPDATE OF state ON blog_post_schedules
WHEN NEW.state = 'claimed' AND NOT EXISTS (
  SELECT 1
  FROM blog_posts AS post
  JOIN content_approvals AS approval
    ON approval.id = NEW.approval_id
   AND approval.workspace_id = NEW.workspace_id
   AND approval.revision = NEW.content_revision
   AND approval.fingerprint = NEW.approval_fingerprint
  JOIN content_workspaces AS workspace
    ON workspace.workspace_id = NEW.workspace_id
   AND workspace.site_id = NEW.site_id
   AND workspace.current_revision = NEW.content_revision
  JOIN blog_post_revisions AS revision
    ON revision.revision_id = NEW.post_revision_id
   AND revision.site_id = NEW.site_id
   AND revision.post_id = NEW.post_id
   AND revision.workspace_id = NEW.workspace_id
   AND revision.content_revision = NEW.content_revision
  LEFT JOIN blog_post_collection_states AS collection
    ON collection.site_id = post.site_id
   AND collection.post_id = post.post_id
  WHERE post.site_id = NEW.site_id
    AND post.post_id = NEW.post_id
    AND COALESCE(collection.collection_state, 'active') = 'active'
    AND post.current_revision_id = NEW.authority_post_revision_id
    AND (
      revision.revision > post.current_revision
      OR revision.revision_id = post.current_revision_id
    )
    AND post.version = NEW.authority_version
    AND EXISTS (
      SELECT 1
      FROM json_each(approval.blog_post_artifacts_json) AS artifact
      WHERE json_extract(artifact.value, '$.postId') = NEW.post_id
        AND json_extract(artifact.value, '$.postRevisionId') =
            NEW.post_revision_id
        AND json_extract(artifact.value, '$.value') =
            revision.artifact_fingerprint
    )
    AND NOT EXISTS (
      SELECT 1 FROM content_approval_invalidations
      WHERE approval_id = NEW.approval_id
    )
    AND approval.production_base = COALESCE((
      SELECT
        'git:' || publication.commit_sha ||
        '@content:' || publication_approval.content_hash
      FROM blog_publication_reconciliation_order AS publication_order
      JOIN content_publications AS publication
        ON publication.id = publication_order.publication_id
      JOIN content_approvals AS publication_approval
        ON publication_approval.id = publication.approval_id
      WHERE publication.status = 'verified-live'
        AND publication.commit_sha IS NOT NULL
      ORDER BY publication_order.sequence DESC
      LIMIT 1
    ), approval.production_base)
    AND NOT EXISTS (
      SELECT 1 FROM content_publications AS publication
      WHERE publication.status IN (
        'requested', 'committed', 'building', 'deployed', 'unknown'
      )
        AND NOT EXISTS (
          SELECT 1 FROM blog_post_schedule_executions AS execution
          WHERE execution.schedule_id = NEW.id
            AND execution.publication_idempotency_key =
                publication.idempotency_key
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM blog_post_schedule_publication_reservations AS reservation
      WHERE reservation.state = 'reserved'
        AND NOT EXISTS (
          SELECT 1 FROM blog_post_schedule_executions AS execution
          WHERE execution.schedule_id = NEW.id
            AND execution.execution_id = reservation.execution_id
        )
    )
) AND NOT EXISTS (
  SELECT 1
  FROM blog_post_schedule_executions AS execution
  JOIN content_publications AS publication
    ON publication.idempotency_key =
       execution.publication_idempotency_key
  WHERE execution.schedule_id = NEW.id
    AND publication.workspace_id = NEW.workspace_id
    AND publication.approval_id = NEW.approval_id
    AND publication.fingerprint = NEW.approval_fingerprint
    AND publication.status IN (
      'requested', 'committed', 'building', 'deployed', 'unknown',
      'verified-live'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_authority_stale');
END;

CREATE TRIGGER content_revisions_cancel_blog_post_schedules
AFTER INSERT ON content_revisions
WHEN NEW.revision > 0
BEGIN
  UPDATE blog_post_schedules
  SET state = 'cancelled',
      detail = 'revision_changed'
  WHERE (
      (
        workspace_id = NEW.workspace_id
        AND content_revision < NEW.revision
      )
      OR (
        workspace_id <> NEW.workspace_id
        AND site_id = (
          SELECT site_id FROM content_workspaces
          WHERE workspace_id = NEW.workspace_id
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(
            json_extract(NEW.definition_json, '$.blog.posts')
          ) AS successor
          JOIN blog_post_revisions AS scheduled_revision
            ON scheduled_revision.revision_id =
               blog_post_schedules.post_revision_id
          WHERE json_extract(successor.value, '$.id') =
                blog_post_schedules.post_id
            AND json(successor.value) <>
                json(scheduled_revision.snapshot_json)
        )
      )
    )
    AND state IN ('active', 'claimed', 'unknown')
    AND NOT EXISTS (
      SELECT 1
      FROM content_publications AS publication
      JOIN blog_post_schedule_executions AS execution
        ON execution.schedule_id = blog_post_schedules.id
       AND execution.publication_idempotency_key =
           publication.idempotency_key
      WHERE publication.workspace_id = blog_post_schedules.workspace_id
        AND publication.approval_id = blog_post_schedules.approval_id
        AND publication.fingerprint =
            blog_post_schedules.approval_fingerprint
        AND publication.status IN (
          'requested', 'committed', 'building', 'deployed', 'unknown',
          'verified-live'
        )
    );
  INSERT INTO blog_post_schedule_execution_events (
    site_id, event_id, execution_id, attempt, actor_id, request_id,
    from_state, to_state, detail, occurred_at
  )
  SELECT
    schedule.site_id,
    'blog.post.schedule.revision-invalidated:' || execution.execution_id ||
      ':' || execution.attempt || ':' || NEW.workspace_id || ':' ||
      NEW.revision,
    execution.execution_id,
    execution.attempt,
    NEW.created_by,
    schedule.id || ':' || NEW.workspace_id || ':' || NEW.revision,
    execution.state,
    'blocked',
    'revision_changed',
    NEW.created_at
  FROM blog_post_schedule_executions AS execution
  JOIN blog_post_schedules AS schedule
    ON schedule.id = execution.schedule_id
  WHERE (
      (
        schedule.workspace_id = NEW.workspace_id
        AND schedule.content_revision < NEW.revision
      )
      OR (
        schedule.workspace_id <> NEW.workspace_id
        AND schedule.site_id = (
          SELECT site_id FROM content_workspaces
          WHERE workspace_id = NEW.workspace_id
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(
            json_extract(NEW.definition_json, '$.blog.posts')
          ) AS successor
          JOIN blog_post_revisions AS scheduled_revision
            ON scheduled_revision.revision_id =
               schedule.post_revision_id
          WHERE json_extract(successor.value, '$.id') = schedule.post_id
            AND json(successor.value) <>
                json(scheduled_revision.snapshot_json)
        )
      )
    )
    AND schedule.detail = 'revision_changed'
    AND execution.state IN ('claimed', 'unknown')
  ON CONFLICT (site_id, event_id) DO NOTHING;
  UPDATE blog_post_schedule_executions
  SET state = 'blocked',
      detail = 'revision_changed',
      lease_token = 'invalidated:' || execution_id || ':' || NEW.revision,
      lease_expires_at = NEW.created_at,
      updated_at = NEW.created_at
  WHERE schedule_id IN (
      SELECT schedule.id FROM blog_post_schedules AS schedule
      WHERE (
        (
          schedule.workspace_id = NEW.workspace_id
          AND schedule.content_revision < NEW.revision
        )
        OR (
          schedule.workspace_id <> NEW.workspace_id
          AND schedule.site_id = (
            SELECT site_id FROM content_workspaces
            WHERE workspace_id = NEW.workspace_id
          )
          AND EXISTS (
            SELECT 1
            FROM json_each(
              json_extract(NEW.definition_json, '$.blog.posts')
            ) AS successor
            JOIN blog_post_revisions AS scheduled_revision
              ON scheduled_revision.revision_id =
                 schedule.post_revision_id
            WHERE json_extract(successor.value, '$.id') =
                  schedule.post_id
              AND json(successor.value) <>
                  json(scheduled_revision.snapshot_json)
          )
        )
      )
        AND detail = 'revision_changed'
    )
    AND state IN ('claimed', 'unknown');
  UPDATE blog_post_schedule_publication_reservations
  SET state = 'released',
      released_at = NEW.created_at
  WHERE execution_id IN (
      SELECT execution.execution_id
      FROM blog_post_schedule_executions AS execution
      JOIN blog_post_schedules AS schedule
        ON schedule.id = execution.schedule_id
      WHERE (
        (
          schedule.workspace_id = NEW.workspace_id
          AND schedule.content_revision < NEW.revision
        )
        OR (
          schedule.workspace_id <> NEW.workspace_id
          AND schedule.site_id = (
            SELECT site_id FROM content_workspaces
            WHERE workspace_id = NEW.workspace_id
          )
          AND EXISTS (
            SELECT 1
            FROM json_each(
              json_extract(NEW.definition_json, '$.blog.posts')
            ) AS successor
            JOIN blog_post_revisions AS scheduled_revision
              ON scheduled_revision.revision_id =
                 schedule.post_revision_id
            WHERE json_extract(successor.value, '$.id') =
                  schedule.post_id
              AND json(successor.value) <>
                  json(scheduled_revision.snapshot_json)
          )
        )
      )
        AND schedule.detail = 'revision_changed'
    );
  UPDATE blog_post_collection_states
  SET workflow_state = 'editing',
      version = version + 1,
      updated_at = NEW.created_at
  WHERE site_id = (
      SELECT site_id FROM content_workspaces
      WHERE workspace_id = NEW.workspace_id
    )
    AND post_id IN (
      SELECT schedule.post_id
      FROM blog_post_schedules AS schedule
      WHERE (
        (
          schedule.workspace_id = NEW.workspace_id
          AND schedule.content_revision < NEW.revision
        )
        OR (
          schedule.workspace_id <> NEW.workspace_id
          AND schedule.site_id = (
            SELECT site_id FROM content_workspaces
            WHERE workspace_id = NEW.workspace_id
          )
          AND EXISTS (
            SELECT 1
            FROM json_each(
              json_extract(NEW.definition_json, '$.blog.posts')
            ) AS successor
            JOIN blog_post_revisions AS scheduled_revision
              ON scheduled_revision.revision_id =
                 schedule.post_revision_id
            WHERE json_extract(successor.value, '$.id') =
                  schedule.post_id
              AND json(successor.value) <>
                  json(scheduled_revision.snapshot_json)
          )
        )
      )
    );
  INSERT INTO blog_post_operation_audit_events (
    event_id, site_id, post_id, actor_id, command_type, request_id,
    outcome, reason_code, before_state_json, after_state_json, occurred_at
  )
  SELECT
    'blog.post.schedule.revision-invalidated:' || schedule.id || ':' ||
      NEW.workspace_id || ':' || NEW.revision,
    schedule.site_id,
    schedule.post_id,
    NEW.created_by,
    'blog.post.schedule.invalidate',
    schedule.id || ':' || NEW.workspace_id || ':' || NEW.revision,
    'accepted',
    'revision_changed',
    COALESCE((
      SELECT json_object(
        'state', event.from_state,
        'executionId', event.execution_id,
        'attempt', event.attempt
      )
      FROM blog_post_schedule_execution_events AS event
      JOIN blog_post_schedule_executions AS execution
        ON execution.execution_id = event.execution_id
      WHERE execution.schedule_id = schedule.id
        AND event.detail = 'revision_changed'
      ORDER BY event.occurred_at DESC
      LIMIT 1
    ), json_object('state', 'active')),
    json_object(
      'state', 'cancelled',
      'executionState', CASE
        WHEN EXISTS (
          SELECT 1 FROM blog_post_schedule_executions
          WHERE schedule_id = schedule.id
        ) THEN 'blocked'
        ELSE NULL
      END,
      'detail', 'revision_changed'
    ),
    NEW.created_at
  FROM blog_post_schedules AS schedule
  WHERE (
      (
        schedule.workspace_id = NEW.workspace_id
        AND schedule.content_revision < NEW.revision
      )
      OR (
        schedule.workspace_id <> NEW.workspace_id
        AND schedule.site_id = (
          SELECT site_id FROM content_workspaces
          WHERE workspace_id = NEW.workspace_id
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(
            json_extract(NEW.definition_json, '$.blog.posts')
          ) AS successor
          JOIN blog_post_revisions AS scheduled_revision
            ON scheduled_revision.revision_id =
               schedule.post_revision_id
          WHERE json_extract(successor.value, '$.id') = schedule.post_id
            AND json(successor.value) <>
                json(scheduled_revision.snapshot_json)
        )
      )
    )
    AND schedule.state = 'cancelled'
    AND schedule.detail = 'revision_changed'
  ON CONFLICT (site_id, command_type, request_id, outcome) DO NOTHING;
END;

CREATE TRIGGER approval_invalidations_cancel_blog_post_schedules
AFTER INSERT ON content_approval_invalidations
BEGIN
  UPDATE blog_post_schedules
  SET state = 'cancelled',
      detail = 'approval_invalidated'
  WHERE approval_id = NEW.approval_id
    AND state IN ('active', 'claimed', 'unknown')
    AND NOT EXISTS (
      SELECT 1
      FROM content_publications AS publication
      JOIN blog_post_schedule_executions AS execution
        ON execution.schedule_id = blog_post_schedules.id
       AND execution.publication_idempotency_key =
           publication.idempotency_key
      WHERE publication.workspace_id = blog_post_schedules.workspace_id
        AND publication.approval_id = blog_post_schedules.approval_id
        AND publication.fingerprint =
            blog_post_schedules.approval_fingerprint
        AND publication.status IN (
          'requested', 'committed', 'building', 'deployed', 'unknown',
          'verified-live'
        )
    );
  INSERT INTO blog_post_schedule_execution_events (
    site_id, event_id, execution_id, attempt, actor_id, request_id,
    from_state, to_state, detail, occurred_at
  )
  SELECT
    schedule.site_id,
    'blog.post.schedule.approval-invalidated:' ||
      execution.execution_id || ':' || execution.attempt || ':' ||
      NEW.invalidated_at,
    execution.execution_id,
    execution.attempt,
    'system:approval',
    schedule.id || ':' || NEW.invalidated_at,
    execution.state,
    'blocked',
    'approval_invalidated',
    NEW.invalidated_at
  FROM blog_post_schedule_executions AS execution
  JOIN blog_post_schedules AS schedule
    ON schedule.id = execution.schedule_id
  WHERE schedule.approval_id = NEW.approval_id
    AND schedule.detail = 'approval_invalidated'
    AND execution.state IN ('claimed', 'unknown')
  ON CONFLICT (site_id, event_id) DO NOTHING;
  UPDATE blog_post_schedule_executions
  SET state = 'blocked',
      detail = 'approval_invalidated',
      lease_token = 'invalidated:' || execution_id || ':' ||
        NEW.invalidated_at,
      lease_expires_at = NEW.invalidated_at,
      updated_at = NEW.invalidated_at
  WHERE schedule_id IN (
      SELECT id FROM blog_post_schedules
      WHERE approval_id = NEW.approval_id
        AND detail = 'approval_invalidated'
    )
    AND state IN ('claimed', 'unknown');
  UPDATE blog_post_schedule_publication_reservations
  SET state = 'released',
      released_at = NEW.invalidated_at
  WHERE execution_id IN (
      SELECT execution.execution_id
      FROM blog_post_schedule_executions AS execution
      JOIN blog_post_schedules AS schedule
        ON schedule.id = execution.schedule_id
      WHERE schedule.approval_id = NEW.approval_id
        AND schedule.detail = 'approval_invalidated'
    );
  UPDATE blog_post_collection_states
  SET workflow_state = 'editing',
      version = version + 1,
      updated_at = NEW.invalidated_at
  WHERE EXISTS (
    SELECT 1 FROM blog_post_schedules
    WHERE approval_id = NEW.approval_id
      AND site_id = blog_post_collection_states.site_id
      AND post_id = blog_post_collection_states.post_id
  );
  INSERT INTO blog_post_operation_audit_events (
    event_id, site_id, post_id, actor_id, command_type, request_id,
    outcome, reason_code, before_state_json, after_state_json, occurred_at
  )
  SELECT
    'blog.post.schedule.invalidated:' || schedule.id || ':' ||
      NEW.invalidated_at,
    schedule.site_id,
    schedule.post_id,
    'system:approval',
    'blog.post.schedule.invalidate',
    schedule.id || ':' || NEW.invalidated_at,
    'accepted',
    'approval_invalidated',
    COALESCE((
      SELECT json_object(
        'state', event.from_state,
        'executionId', event.execution_id,
        'attempt', event.attempt
      )
      FROM blog_post_schedule_execution_events AS event
      JOIN blog_post_schedule_executions AS execution
        ON execution.execution_id = event.execution_id
      WHERE execution.schedule_id = schedule.id
        AND event.detail = 'approval_invalidated'
      ORDER BY event.occurred_at DESC
      LIMIT 1
    ), json_object('state', 'active')),
    json_object(
      'state', 'cancelled',
      'executionState', CASE
        WHEN EXISTS (
          SELECT 1 FROM blog_post_schedule_executions
          WHERE schedule_id = schedule.id
        ) THEN 'blocked'
        ELSE NULL
      END,
      'detail', 'approval_invalidated'
    ),
    NEW.invalidated_at
  FROM blog_post_schedules AS schedule
  WHERE schedule.approval_id = NEW.approval_id
    AND schedule.state = 'cancelled'
    AND schedule.detail = 'approval_invalidated'
  ON CONFLICT (site_id, command_type, request_id, outcome) DO NOTHING;
END;

CREATE TRIGGER content_publications_respect_schedule_reservation
BEFORE INSERT ON content_publications
WHEN NEW.status IN (
  'requested', 'committed', 'building', 'deployed', 'unknown'
) AND EXISTS (
  SELECT 1
  FROM blog_post_schedule_publication_reservations AS reservation
  WHERE reservation.state = 'reserved'
    AND reservation.publication_idempotency_key <> NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_publication_reserved');
END;

CREATE TRIGGER content_approvals_require_active_blog_posts
BEFORE INSERT ON content_approvals
WHEN EXISTS (
  SELECT 1
  FROM json_each(NEW.blog_post_artifacts_json) AS artifact
  JOIN content_workspaces AS workspace
    ON workspace.workspace_id = NEW.workspace_id
  JOIN blog_posts AS post
    ON post.site_id = workspace.site_id
   AND post.post_id = json_extract(artifact.value, '$.postId')
  LEFT JOIN blog_post_revisions AS revision
    ON revision.revision_id =
         json_extract(artifact.value, '$.postRevisionId')
   AND revision.site_id = post.site_id
   AND revision.post_id = post.post_id
  LEFT JOIN blog_post_collection_states AS collection
    ON collection.site_id = post.site_id
   AND collection.post_id = post.post_id
  WHERE COALESCE(collection.collection_state, 'active') <> 'active'
    AND NOT (
      collection.collection_state = 'archiving'
      AND collection.withdrawal_workspace_id = NEW.workspace_id
      AND collection.withdrawal_content_revision = NEW.revision
      AND revision.workspace_id = NEW.workspace_id
      AND revision.content_revision = NEW.revision
      AND json_extract(
        revision.snapshot_json,
        '$.targetVisibility'
      ) = 'unpublished'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_collection_authority_stale');
END;

CREATE TRIGGER content_publications_require_active_blog_posts
BEFORE INSERT ON content_publications
WHEN NEW.status IN (
  'requested', 'committed', 'building', 'deployed', 'unknown'
) AND EXISTS (
  SELECT 1
  FROM content_approvals AS approval
  JOIN content_workspaces AS workspace
    ON workspace.workspace_id = approval.workspace_id
  JOIN json_each(approval.blog_post_artifacts_json) AS artifact
  JOIN blog_posts AS post
    ON post.site_id = workspace.site_id
   AND post.post_id = json_extract(artifact.value, '$.postId')
  LEFT JOIN blog_post_revisions AS revision
    ON revision.revision_id =
         json_extract(artifact.value, '$.postRevisionId')
   AND revision.site_id = post.site_id
   AND revision.post_id = post.post_id
  LEFT JOIN blog_post_collection_states AS collection
    ON collection.site_id = post.site_id
   AND collection.post_id = post.post_id
  WHERE approval.id = NEW.approval_id
    AND COALESCE(collection.collection_state, 'active') <> 'active'
    AND NOT (
      collection.collection_state = 'archiving'
      AND collection.withdrawal_workspace_id = approval.workspace_id
      AND collection.withdrawal_content_revision = approval.revision
      AND revision.workspace_id = approval.workspace_id
      AND revision.content_revision = approval.revision
      AND json_extract(
        revision.snapshot_json,
        '$.targetVisibility'
      ) = 'unpublished'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_collection_authority_stale');
END;

CREATE TRIGGER content_publications_respect_schedule_reservation_update
BEFORE UPDATE OF status ON content_publications
WHEN NEW.status IN (
  'requested', 'committed', 'building', 'deployed', 'unknown'
) AND (
  EXISTS (
    SELECT 1
    FROM blog_post_schedule_publication_reservations AS reservation
    WHERE reservation.state = 'reserved'
      AND reservation.publication_idempotency_key <> NEW.idempotency_key
  )
  OR EXISTS (
    SELECT 1
    FROM blog_post_schedule_publication_reservations AS reservation
    JOIN blog_post_schedule_executions AS execution
      ON execution.execution_id = reservation.execution_id
    WHERE reservation.publication_idempotency_key = NEW.idempotency_key
      AND (
        reservation.state <> 'reserved'
        OR OLD.schedule_execution_id <> reservation.execution_id
        OR execution.state <> 'claimed'
        OR execution.attempt <> reservation.attempt
        OR execution.lease_token <> reservation.lease_token
        OR execution.lease_expires_at <= NEW.updated_at
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_publication_reserved');
END;

CREATE TRIGGER content_publications_require_active_blog_posts_update
BEFORE UPDATE OF status ON content_publications
WHEN NEW.status IN (
  'requested', 'committed', 'building', 'deployed', 'unknown'
) AND EXISTS (
  SELECT 1
  FROM content_approvals AS approval
  JOIN content_workspaces AS workspace
    ON workspace.workspace_id = approval.workspace_id
  JOIN json_each(approval.blog_post_artifacts_json) AS artifact
  JOIN blog_posts AS post
    ON post.site_id = workspace.site_id
   AND post.post_id = json_extract(artifact.value, '$.postId')
  LEFT JOIN blog_post_revisions AS revision
    ON revision.revision_id =
         json_extract(artifact.value, '$.postRevisionId')
   AND revision.site_id = post.site_id
   AND revision.post_id = post.post_id
  LEFT JOIN blog_post_collection_states AS collection
    ON collection.site_id = post.site_id
   AND collection.post_id = post.post_id
  WHERE approval.id = NEW.approval_id
    AND COALESCE(collection.collection_state, 'active') <> 'active'
    AND NOT (
      collection.collection_state = 'archiving'
      AND collection.withdrawal_workspace_id = approval.workspace_id
      AND collection.withdrawal_content_revision = approval.revision
      AND revision.workspace_id = approval.workspace_id
      AND revision.content_revision = approval.revision
      AND json_extract(
        revision.snapshot_json,
        '$.targetVisibility'
      ) = 'unpublished'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_collection_authority_stale');
END;

CREATE TRIGGER blog_post_restore_records_require_active_draft
BEFORE INSERT ON blog_post_restore_records
WHEN NOT EXISTS (
  SELECT 1
  FROM blog_post_collection_states AS collection
  JOIN blog_posts AS post
    ON post.site_id = collection.site_id
   AND post.post_id = collection.post_id
  JOIN blog_post_revisions AS revision
    ON revision.revision_id = NEW.restored_post_revision_id
   AND revision.site_id = NEW.site_id
   AND revision.post_id = NEW.post_id
   AND revision.workspace_id = NEW.restored_workspace_id
   AND revision.content_revision = NEW.restored_content_revision
  WHERE collection.site_id = NEW.site_id
    AND collection.post_id = NEW.post_id
    AND collection.collection_state = 'active'
    AND collection.restore_request_id = NEW.request_id
    AND post.current_revision_id = NEW.restored_post_revision_id
    AND json_extract(revision.snapshot_json, '$.targetVisibility') =
        'unpublished'
)
BEGIN
  SELECT RAISE(ABORT, 'blog_post_restore_aggregate_not_advanced');
END;

CREATE TRIGGER blog_post_restore_audit_requires_receipt
BEFORE INSERT ON blog_post_operation_audit_events
WHEN NEW.command_type = 'blog.post.restore'
  AND NEW.outcome = 'accepted'
  AND NOT EXISTS (
    SELECT 1
    FROM blog_post_restore_records AS record
    WHERE record.site_id = NEW.site_id
      AND record.post_id = NEW.post_id
      AND record.request_id = NEW.request_id
      AND record.actor_id = NEW.actor_id
      AND record.response_json = NEW.after_state_json
  )
BEGIN
  SELECT RAISE(ABORT, 'blog_post_restore_receipt_missing');
END;

CREATE TRIGGER blog_post_schedules_prevent_delete
BEFORE DELETE ON blog_post_schedules
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_history_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_proposals_prevent_update
BEFORE UPDATE ON blog_post_schedule_proposals
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_proposal_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_proposals_prevent_delete
BEFORE DELETE ON blog_post_schedule_proposals
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_proposal_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_cancellations_prevent_update
BEFORE UPDATE ON blog_post_schedule_cancellations
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_cancellation_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_cancellations_prevent_delete
BEFORE DELETE ON blog_post_schedule_cancellations
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_cancellation_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_executions_prevent_delete
BEFORE DELETE ON blog_post_schedule_executions
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_execution_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_retry_receipts_prevent_update
BEFORE UPDATE ON blog_post_schedule_retry_receipts
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_retry_receipt_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_retry_receipts_prevent_delete
BEFORE DELETE ON blog_post_schedule_retry_receipts
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_retry_receipt_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_execution_outcomes_prevent_update
BEFORE UPDATE ON blog_post_schedule_execution_outcomes
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_execution_outcome_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_execution_outcomes_prevent_delete
BEFORE DELETE ON blog_post_schedule_execution_outcomes
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_execution_outcome_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_execution_events_prevent_update
BEFORE UPDATE ON blog_post_schedule_execution_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_execution_event_is_immutable');
END;

CREATE TRIGGER blog_post_schedule_execution_events_prevent_delete
BEFORE DELETE ON blog_post_schedule_execution_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_schedule_execution_event_is_immutable');
END;

CREATE TRIGGER blog_post_archive_records_prevent_update
BEFORE UPDATE ON blog_post_archive_records
BEGIN
  SELECT RAISE(ABORT, 'blog_post_archive_record_is_immutable');
END;

CREATE TRIGGER blog_post_archive_records_prevent_delete
BEFORE DELETE ON blog_post_archive_records
BEGIN
  SELECT RAISE(ABORT, 'blog_post_archive_record_is_immutable');
END;

CREATE TRIGGER blog_post_restore_records_prevent_update
BEFORE UPDATE ON blog_post_restore_records
BEGIN
  SELECT RAISE(ABORT, 'blog_post_restore_record_is_immutable');
END;

CREATE TRIGGER blog_post_restore_records_prevent_delete
BEFORE DELETE ON blog_post_restore_records
BEGIN
  SELECT RAISE(ABORT, 'blog_post_restore_record_is_immutable');
END;

CREATE TRIGGER blog_post_operation_audit_prevent_update
BEFORE UPDATE ON blog_post_operation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_operation_audit_is_immutable');
END;

CREATE TRIGGER blog_post_operation_audit_prevent_delete
BEFORE DELETE ON blog_post_operation_audit_events
BEGIN
  SELECT RAISE(ABORT, 'blog_post_operation_audit_is_immutable');
END;
