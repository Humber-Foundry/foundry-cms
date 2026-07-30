CREATE TABLE campaign_bulk_authorizations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_revision_id TEXT NOT NULL,
  campaign_fingerprint TEXT NOT NULL,
  test_execution_id TEXT NOT NULL,
  test_provider_receipt_hash TEXT NOT NULL,
  test_html_fingerprint TEXT NOT NULL,
  test_text_fingerprint TEXT NOT NULL,
  test_sender_fingerprint TEXT NOT NULL,
  test_provider_configuration_fingerprint TEXT NOT NULL,
  authorization_fingerprint TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('active', 'consumed', 'invalidated')
  ),
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  invalidated_at TEXT,
  UNIQUE (site_id, owner_actor_id, request_id),
  UNIQUE (id, site_id, campaign_id),
  UNIQUE (id, site_id, campaign_id, campaign_revision_id),
  FOREIGN KEY (site_id, campaign_id)
    REFERENCES campaigns(site_id, id),
  FOREIGN KEY (campaign_revision_id, site_id, campaign_id)
    REFERENCES campaign_revisions(id, site_id, campaign_id),
  FOREIGN KEY (test_execution_id, site_id)
    REFERENCES campaign_test_deliveries(execution_id, site_id),
  FOREIGN KEY (test_execution_id)
    REFERENCES campaign_test_receipt_confirmations(execution_id),
  CHECK (
    (state = 'invalidated' AND invalidated_at IS NOT NULL)
    OR (state <> 'invalidated' AND invalidated_at IS NULL)
  )
);

CREATE TABLE campaign_bulk_audit_events (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'campaign.bulk.authorize',
      'campaign.bulk.schedule',
      'campaign.bulk.cancel',
      'campaign.bulk.send_now',
      'campaign.bulk.retry_send'
    )
  ),
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome = 'rejected'),
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TRIGGER campaign_bulk_audit_events_prevent_update
BEFORE UPDATE ON campaign_bulk_audit_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_audit_event_is_immutable');
END;

CREATE TRIGGER campaign_bulk_audit_events_prevent_delete
BEFORE DELETE ON campaign_bulk_audit_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_audit_event_is_immutable');
END;

CREATE UNIQUE INDEX campaign_bulk_authorizations_one_active
ON campaign_bulk_authorizations (site_id, campaign_id)
WHERE state = 'active';

CREATE TRIGGER campaign_bulk_authorizations_require_exact_owner_evidence
BEFORE INSERT ON campaign_bulk_authorizations
WHEN NOT EXISTS (
  SELECT 1
  FROM campaigns AS campaign
  JOIN campaign_revisions AS revision
    ON revision.id = NEW.campaign_revision_id
   AND revision.site_id = campaign.site_id
   AND revision.campaign_id = campaign.id
  JOIN campaign_test_deliveries AS test
    ON test.execution_id = NEW.test_execution_id
   AND test.site_id = campaign.site_id
   AND test.campaign_id = campaign.id
   AND test.campaign_revision_id = revision.id
   AND test.state = 'accepted'
   AND json_extract(test.binding_json, '$.campaignFingerprint') =
       NEW.campaign_fingerprint
   AND json_extract(test.evidence_json, '$.providerReceiptHash') =
       NEW.test_provider_receipt_hash
   AND json_extract(test.binding_json, '$.htmlFingerprint') =
       NEW.test_html_fingerprint
   AND json_extract(test.binding_json, '$.textFingerprint') =
       NEW.test_text_fingerprint
   AND json_extract(test.binding_json, '$.senderFingerprint') =
       NEW.test_sender_fingerprint
   AND json_extract(
         test.binding_json, '$.providerConfigurationFingerprint'
       ) = NEW.test_provider_configuration_fingerprint
  JOIN campaign_test_receipt_confirmations AS confirmation
    ON confirmation.execution_id = test.execution_id
   AND confirmation.site_id = campaign.site_id
   AND confirmation.owner_actor_id = NEW.owner_actor_id
  JOIN human_memberships AS membership
    ON membership.id = NEW.owner_actor_id
   AND membership.site_id = campaign.site_id
   AND membership.role = 'owner'
   AND membership.status = 'active'
  WHERE campaign.site_id = NEW.site_id
    AND campaign.id = NEW.campaign_id
    AND campaign.current_revision_id = revision.id
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_owner_evidence_required');
END;

CREATE TRIGGER campaign_bulk_authorizations_preserve_identity
BEFORE UPDATE ON campaign_bulk_authorizations
WHEN NEW.id <> OLD.id
  OR NEW.site_id <> OLD.site_id
  OR NEW.campaign_id <> OLD.campaign_id
  OR NEW.campaign_revision_id <> OLD.campaign_revision_id
  OR NEW.campaign_fingerprint <> OLD.campaign_fingerprint
  OR NEW.test_execution_id <> OLD.test_execution_id
  OR NEW.test_provider_receipt_hash <> OLD.test_provider_receipt_hash
  OR NEW.test_html_fingerprint <> OLD.test_html_fingerprint
  OR NEW.test_text_fingerprint <> OLD.test_text_fingerprint
  OR NEW.test_sender_fingerprint <> OLD.test_sender_fingerprint
  OR NEW.test_provider_configuration_fingerprint <>
      OLD.test_provider_configuration_fingerprint
  OR NEW.authorization_fingerprint <> OLD.authorization_fingerprint
  OR NEW.owner_actor_id <> OLD.owner_actor_id
  OR NEW.request_id <> OLD.request_id
  OR NEW.input_hash <> OLD.input_hash
  OR NEW.authorized_at <> OLD.authorized_at
  OR OLD.state <> 'active'
  OR NEW.state NOT IN ('consumed', 'invalidated')
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_authorization_is_immutable');
END;

CREATE TRIGGER campaign_bulk_authorizations_prevent_delete
BEFORE DELETE ON campaign_bulk_authorizations
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_authorization_is_immutable');
END;

CREATE TABLE campaign_bulk_schedules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  local_date_time TEXT NOT NULL,
  iana_time_zone TEXT NOT NULL,
  utc_offset_choice TEXT NOT NULL,
  execute_at_utc TEXT NOT NULL,
  time_zone_database_version TEXT NOT NULL,
  activated_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'active', 'claimed', 'completed', 'cancelled', 'blocked', 'missed'
    )
  ),
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, activated_by, request_id),
  UNIQUE (id, execute_at_utc),
  FOREIGN KEY (authorization_id, site_id, campaign_id)
    REFERENCES campaign_bulk_authorizations(id, site_id, campaign_id)
);

CREATE UNIQUE INDEX campaign_bulk_schedules_one_active
ON campaign_bulk_schedules (site_id, campaign_id)
WHERE state = 'active';

CREATE TRIGGER campaign_bulk_schedules_require_current_owner_authority
BEFORE INSERT ON campaign_bulk_schedules
WHEN NOT EXISTS (
  SELECT 1
  FROM campaign_bulk_authorizations AS authorization
  JOIN campaigns AS campaign
    ON campaign.site_id = authorization.site_id
   AND campaign.id = authorization.campaign_id
   AND campaign.current_revision_id = authorization.campaign_revision_id
  JOIN human_memberships AS membership
    ON membership.site_id = authorization.site_id
   AND membership.id = authorization.owner_actor_id
   AND membership.role = 'owner'
   AND membership.status = 'active'
  WHERE authorization.id = NEW.authorization_id
    AND authorization.site_id = NEW.site_id
    AND authorization.campaign_id = NEW.campaign_id
    AND authorization.owner_actor_id = NEW.activated_by
    AND authorization.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_authorization_stale');
END;

CREATE TRIGGER campaign_bulk_schedules_prevent_competing_send
BEFORE INSERT ON campaign_bulk_schedules
WHEN EXISTS (
  SELECT 1
  FROM campaign_bulk_send_operations AS operation
  WHERE operation.site_id = NEW.site_id
    AND operation.campaign_id = NEW.campaign_id
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_send_already_exists');
END;

CREATE TRIGGER campaign_bulk_schedules_preserve_identity
BEFORE UPDATE ON campaign_bulk_schedules
WHEN NEW.id <> OLD.id
  OR NEW.site_id <> OLD.site_id
  OR NEW.campaign_id <> OLD.campaign_id
  OR NEW.authorization_id <> OLD.authorization_id
  OR NEW.local_date_time <> OLD.local_date_time
  OR NEW.iana_time_zone <> OLD.iana_time_zone
  OR NEW.utc_offset_choice <> OLD.utc_offset_choice
  OR NEW.execute_at_utc <> OLD.execute_at_utc
  OR NEW.time_zone_database_version <> OLD.time_zone_database_version
  OR NEW.activated_by <> OLD.activated_by
  OR NEW.request_id <> OLD.request_id
  OR NEW.input_hash <> OLD.input_hash
  OR NEW.created_at <> OLD.created_at
  OR OLD.state NOT IN ('active', 'claimed')
  OR (
    OLD.state = 'active'
    AND NEW.state NOT IN ('claimed', 'cancelled', 'blocked', 'missed')
  )
  OR (
    OLD.state = 'claimed'
    AND NEW.state NOT IN ('completed', 'blocked')
  )
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_schedule_transition_invalid');
END;

CREATE TRIGGER campaign_bulk_schedules_prevent_delete
BEFORE DELETE ON campaign_bulk_schedules
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_schedule_is_immutable');
END;

CREATE TABLE campaign_bulk_send_operations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_revision_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  schedule_id TEXT,
  scheduled_instant TEXT,
  stable_send_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN (
      'preparing', 'attempting', 'ambiguous', 'provider_queued',
      'sent', 'failed', 'blocked'
    )
  ),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  lease_token TEXT,
  lease_expires_at TEXT,
  audience_snapshot_json TEXT,
  send_artifact_json TEXT,
  send_artifact_hash TEXT,
  send_artifact_commit_sha TEXT,
  provider_campaign_id TEXT,
  provider_message_id TEXT,
  provider_send_proof TEXT,
  provider_verification_json TEXT,
  detail TEXT,
  request_actor_id TEXT,
  request_id TEXT,
  input_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, request_actor_id, request_id),
  UNIQUE (schedule_id, scheduled_instant),
  FOREIGN KEY (authorization_id, site_id, campaign_id, campaign_revision_id)
    REFERENCES campaign_bulk_authorizations(
      id, site_id, campaign_id, campaign_revision_id
    ),
  FOREIGN KEY (schedule_id, scheduled_instant)
    REFERENCES campaign_bulk_schedules(id, execute_at_utc),
  CHECK (
    (schedule_id IS NULL AND scheduled_instant IS NULL)
    OR (schedule_id IS NOT NULL AND scheduled_instant IS NOT NULL)
  ),
  CHECK (
    (request_actor_id IS NULL AND request_id IS NULL AND input_hash IS NULL)
    OR (
      request_actor_id IS NOT NULL
      AND request_id IS NOT NULL
      AND input_hash IS NOT NULL
    )
  ),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (
      audience_snapshot_json IS NULL
      AND send_artifact_json IS NULL
      AND send_artifact_hash IS NULL
    )
    OR (
      audience_snapshot_json IS NOT NULL
      AND send_artifact_json IS NOT NULL
      AND send_artifact_hash IS NOT NULL
      AND json_valid(audience_snapshot_json) = 1
      AND json_type(audience_snapshot_json, '$.recipients') IS 'array'
      AND json_array_length(
        json_extract(audience_snapshot_json, '$.recipients')
      ) > 0
      AND json_type(audience_snapshot_json, '$.recipientCount') IS 'integer'
      AND json_extract(audience_snapshot_json, '$.recipientCount') IS
          json_array_length(
            json_extract(audience_snapshot_json, '$.recipients')
          )
      AND json_valid(send_artifact_json) = 1
      AND json_type(send_artifact_json, '$.recipientCount') IS 'integer'
      AND json_extract(send_artifact_json, '$.recipientCount') IS
          json_array_length(
            json_extract(audience_snapshot_json, '$.recipients')
          )
    )
  )
);

CREATE UNIQUE INDEX campaign_bulk_send_one_logical_operation
ON campaign_bulk_send_operations (site_id, campaign_id);

CREATE TRIGGER campaign_bulk_send_operations_require_current_authority
BEFORE INSERT ON campaign_bulk_send_operations
WHEN NOT EXISTS (
  SELECT 1
  FROM campaign_bulk_authorizations AS authorization
  JOIN campaigns AS campaign
    ON campaign.site_id = authorization.site_id
   AND campaign.id = authorization.campaign_id
   AND campaign.current_revision_id = authorization.campaign_revision_id
  JOIN human_memberships AS membership
    ON membership.site_id = authorization.site_id
   AND membership.id = authorization.owner_actor_id
   AND membership.role = 'owner'
   AND membership.status = 'active'
  WHERE authorization.id = NEW.authorization_id
    AND authorization.site_id = NEW.site_id
    AND authorization.campaign_id = NEW.campaign_id
    AND authorization.campaign_revision_id = NEW.campaign_revision_id
    AND authorization.state = 'active'
    AND (
      NEW.schedule_id IS NOT NULL
      OR NEW.request_actor_id = authorization.owner_actor_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_authorization_stale');
END;

CREATE TRIGGER campaign_bulk_send_operations_preserve_identity
BEFORE UPDATE ON campaign_bulk_send_operations
WHEN NEW.id IS NOT OLD.id
  OR NEW.site_id IS NOT OLD.site_id
  OR NEW.campaign_id IS NOT OLD.campaign_id
  OR NEW.campaign_revision_id IS NOT OLD.campaign_revision_id
  OR NEW.authorization_id IS NOT OLD.authorization_id
  OR NEW.schedule_id IS NOT OLD.schedule_id
  OR NEW.scheduled_instant IS NOT OLD.scheduled_instant
  OR NEW.stable_send_key IS NOT OLD.stable_send_key
  OR NEW.request_actor_id IS NOT OLD.request_actor_id
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.created_at IS NOT OLD.created_at
  OR (
    OLD.provider_send_proof IS NOT NULL
    AND (
      NEW.audience_snapshot_json IS NOT OLD.audience_snapshot_json
      OR NEW.send_artifact_json IS NOT OLD.send_artifact_json
      OR NEW.send_artifact_hash IS NOT OLD.send_artifact_hash
      OR NEW.send_artifact_commit_sha IS NOT OLD.send_artifact_commit_sha
    )
  )
  OR (
    OLD.provider_campaign_id IS NOT NULL
    AND NEW.provider_campaign_id IS NOT OLD.provider_campaign_id
  )
  OR (
    OLD.provider_message_id IS NOT NULL
    AND NEW.provider_message_id IS NOT OLD.provider_message_id
  )
  OR (
    OLD.provider_send_proof IS NOT NULL
    AND NEW.provider_send_proof IS NOT OLD.provider_send_proof
  )
  OR (
    OLD.provider_verification_json IS NOT NULL
    AND NEW.provider_verification_json IS NOT OLD.provider_verification_json
  )
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_send_operation_identity_is_immutable');
END;

CREATE TRIGGER campaign_bulk_send_operations_legal_transition
BEFORE UPDATE OF state ON campaign_bulk_send_operations
WHEN NEW.state <> OLD.state
  AND NOT (
    (OLD.state = 'preparing' AND NEW.state IN ('attempting', 'blocked'))
    OR (
      OLD.state = 'attempting'
      AND NEW.state IN (
        'ambiguous', 'provider_queued', 'failed', 'blocked'
      )
    )
    OR (
      OLD.state = 'ambiguous'
      AND NEW.state IN ('attempting', 'failed', 'sent')
    )
    OR (
      OLD.state = 'provider_queued'
      AND NEW.state = 'sent'
    )
    OR (
      OLD.state IN ('failed', 'blocked')
      AND NEW.state = 'preparing'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_send_transition_invalid');
END;

CREATE TRIGGER campaign_bulk_send_operations_cancel_competing_schedule
AFTER INSERT ON campaign_bulk_send_operations
WHEN NEW.request_actor_id IS NOT NULL
BEGIN
  UPDATE campaign_bulk_schedules
  SET state = 'cancelled', updated_at = NEW.created_at
  WHERE authorization_id = NEW.authorization_id
    AND state = 'active';
END;

CREATE TRIGGER campaign_bulk_send_operations_prevent_delete
BEFORE DELETE ON campaign_bulk_send_operations
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_send_operation_is_immutable');
END;

CREATE TABLE campaign_bulk_delivery_events (
  event_id TEXT PRIMARY KEY,
  payload_fingerprint TEXT NOT NULL,
  site_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  provider_campaign_id TEXT NOT NULL,
  provider_message_id TEXT,
  provider_send_proof TEXT,
  recipient_identity_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'accepted', 'delivered', 'opened', 'clicked',
      'unsubscribed', 'hard_bounced', 'complained',
      'soft_bounced', 'blocked', 'invalid', 'deferred', 'provider_error'
    )
  ),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'poll')),
  FOREIGN KEY (operation_id)
    REFERENCES campaign_bulk_send_operations(id),
  CHECK (
    (source = 'webhook' AND provider_send_proof IS NOT NULL)
    OR (source = 'poll' AND provider_send_proof IS NULL)
  )
);

CREATE INDEX campaign_bulk_delivery_events_operation
ON campaign_bulk_delivery_events (
  site_id, operation_id, occurred_at, event_id
);

CREATE TRIGGER campaign_bulk_delivery_events_prevent_update
BEFORE UPDATE ON campaign_bulk_delivery_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_delivery_event_is_immutable');
END;

CREATE TRIGGER campaign_bulk_delivery_events_prevent_delete
BEFORE DELETE ON campaign_bulk_delivery_events
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_delivery_event_is_immutable');
END;

CREATE TRIGGER campaign_bulk_send_operations_require_provider_evidence
BEFORE UPDATE OF state ON campaign_bulk_send_operations
WHEN (
  NEW.state = 'provider_queued'
  AND (
    NEW.audience_snapshot_json IS NULL
    OR NEW.send_artifact_json IS NULL
    OR NEW.send_artifact_hash IS NULL
    OR NEW.send_artifact_commit_sha IS NULL
    OR NEW.provider_campaign_id IS NULL
    OR NEW.provider_send_proof IS NULL
  )
) OR (
  NEW.state = 'sent'
  AND (
    NEW.audience_snapshot_json IS NULL
    OR NEW.send_artifact_json IS NULL
    OR NEW.send_artifact_hash IS NULL
    OR NEW.send_artifact_commit_sha IS NULL
    OR NEW.provider_campaign_id IS NULL
    OR NEW.provider_send_proof IS NULL
    OR NEW.provider_verification_json IS NULL
    OR json_valid(NEW.provider_verification_json) <> 1
    OR json_type(
      NEW.provider_verification_json, '$.providerMessageIds'
    ) IS NOT 'array'
    OR json_array_length(
      json_extract(NEW.provider_verification_json, '$.providerMessageIds')
    ) <= 0
    OR (
      SELECT COUNT(DISTINCT value)
      FROM json_each(
        json_extract(
          NEW.provider_verification_json, '$.providerMessageIds'
        )
      )
    ) <> json_array_length(
      json_extract(NEW.provider_verification_json, '$.providerMessageIds')
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(
          NEW.provider_verification_json, '$.providerMessageIds'
        )
      ) AS provider_message
      WHERE provider_message.type IS NOT 'text'
        OR length(trim(provider_message.value)) = 0
        OR length(provider_message.value) > 512
    )
    OR json_type(NEW.audience_snapshot_json, '$.recipients') IS NOT 'array'
    OR json_array_length(
      json_extract(NEW.audience_snapshot_json, '$.recipients')
    ) <= 0
    OR (
      SELECT COUNT(DISTINCT event.recipient_identity_key)
      FROM campaign_bulk_delivery_events AS event
      WHERE event.operation_id = NEW.id
        AND event.site_id = NEW.site_id
        AND event.provider_campaign_id = NEW.provider_campaign_id
        AND event.provider_send_proof = NEW.provider_send_proof
        AND event.source = 'webhook'
        AND event.event_type IN (
          'accepted', 'delivered', 'opened', 'clicked',
          'unsubscribed', 'complained', 'hard_bounced',
          'soft_bounced', 'deferred'
        )
        AND event.provider_message_id IN (
          SELECT value
          FROM json_each(
            json_extract(
              NEW.provider_verification_json, '$.providerMessageIds'
            )
          )
        )
    ) <> json_array_length(
      json_extract(NEW.audience_snapshot_json, '$.recipients')
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(NEW.audience_snapshot_json, '$.recipients')
      ) AS expected
      WHERE json_extract(expected.value, '$.identityKey') NOT IN (
        SELECT event.recipient_identity_key
        FROM campaign_bulk_delivery_events AS event
        WHERE event.operation_id = NEW.id
          AND event.site_id = NEW.site_id
          AND event.provider_campaign_id = NEW.provider_campaign_id
          AND event.provider_send_proof = NEW.provider_send_proof
          AND event.source = 'webhook'
          AND event.event_type IN (
            'accepted', 'delivered', 'opened', 'clicked',
            'unsubscribed', 'complained', 'hard_bounced',
            'soft_bounced', 'deferred'
          )
          AND event.provider_message_id IN (
            SELECT value
            FROM json_each(
              json_extract(
                NEW.provider_verification_json, '$.providerMessageIds'
              )
            )
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(
        json_extract(
          NEW.provider_verification_json, '$.providerMessageIds'
        )
      ) AS expected_message
      WHERE expected_message.value NOT IN (
        SELECT event.provider_message_id
        FROM campaign_bulk_delivery_events AS event
        WHERE event.operation_id = NEW.id
          AND event.site_id = NEW.site_id
          AND event.provider_campaign_id = NEW.provider_campaign_id
          AND event.provider_send_proof = NEW.provider_send_proof
          AND event.source = 'webhook'
          AND event.event_type IN (
            'accepted', 'delivered', 'opened', 'clicked',
            'unsubscribed', 'complained', 'hard_bounced',
            'soft_bounced', 'deferred'
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM campaign_bulk_delivery_events AS event
      WHERE event.operation_id = NEW.id
        AND event.site_id = NEW.site_id
        AND event.provider_campaign_id = NEW.provider_campaign_id
        AND event.provider_send_proof = NEW.provider_send_proof
        AND event.source = 'webhook'
        AND event.event_type IN (
          'accepted', 'delivered', 'opened', 'clicked',
          'unsubscribed', 'complained', 'hard_bounced',
          'soft_bounced', 'deferred'
        )
        AND (
          event.provider_message_id IS NULL
          OR event.provider_message_id NOT IN (
            SELECT value
            FROM json_each(
              json_extract(
                NEW.provider_verification_json, '$.providerMessageIds'
              )
            )
          )
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'campaign_bulk_provider_evidence_incomplete');
END;

CREATE TRIGGER campaign_edit_invalidates_bulk_authority
AFTER UPDATE OF current_revision_id ON campaigns
WHEN NEW.current_revision_id <> OLD.current_revision_id
BEGIN
  UPDATE campaign_bulk_authorizations
  SET state = 'invalidated', invalidated_at = NEW.updated_at
  WHERE site_id = NEW.site_id
    AND campaign_id = NEW.id
    AND state = 'active';

  UPDATE campaign_bulk_schedules
  SET state = 'blocked', updated_at = NEW.updated_at
  WHERE site_id = NEW.site_id
    AND campaign_id = NEW.id
    AND state IN ('active', 'claimed');

  UPDATE campaign_bulk_send_operations
  SET state = 'blocked',
      detail = 'campaign_revision_changed',
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = NEW.updated_at
  WHERE site_id = NEW.site_id
    AND campaign_id = NEW.id
    AND state = 'preparing';
END;

CREATE TRIGGER campaign_owner_revocation_invalidates_bulk_authority
AFTER UPDATE OF status, role ON human_memberships
WHEN OLD.status <> NEW.status
  OR OLD.role <> NEW.role
BEGIN
  UPDATE campaign_bulk_authorizations
  SET state = 'invalidated',
      invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE site_id = NEW.site_id
    AND owner_actor_id = NEW.id
    AND state = 'active'
    AND (NEW.status <> 'active' OR NEW.role <> 'owner');

  UPDATE campaign_bulk_schedules
  SET state = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE authorization_id IN (
    SELECT id FROM campaign_bulk_authorizations
    WHERE site_id = NEW.site_id
      AND owner_actor_id = NEW.id
      AND state = 'invalidated'
  )
    AND state IN ('active', 'claimed');

  UPDATE campaign_bulk_send_operations
  SET state = 'blocked',
      detail = 'owner_authority_revoked',
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE authorization_id IN (
    SELECT id FROM campaign_bulk_authorizations
    WHERE site_id = NEW.site_id
      AND owner_actor_id = NEW.id
      AND state = 'invalidated'
  )
    AND state = 'preparing';
END;
