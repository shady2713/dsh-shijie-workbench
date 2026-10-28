-- v1.3 fresh-database DDL. Not a migration script.
-- v1.3: sampling parameters are change-based; job claims carry a monotonic claim_generation.
-- v1.2: media/frames carry VIDEO|IMAGE kinds; a still image is a STILL_IMAGE frame with no time fields.
-- Domain and auth checks remain mandatory at the service boundary.
-- Journal mode is selected by deployment validation, not forced here.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY, applied_at TEXT NOT NULL
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
  case_set_version INTEGER NOT NULL DEFAULT 1 CHECK(case_set_version>=1),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','READY','RUNNING','WAITING_AGENT','WAITING_APPROVAL','BLOCKED','REVIEW_READY','CLOSED_COMPLETE','CLOSED_PARTIAL','CANCELLED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE task_revisions (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
  spec_sha256 TEXT NOT NULL CHECK(length(spec_sha256)=64),
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,revision)
);
CREATE TABLE search_runs (
  search_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  task_revision INTEGER NOT NULL,
  query_id TEXT NOT NULL REFERENCES search_queries(query_id),
  platform_id TEXT NOT NULL, adapter_id TEXT NOT NULL,
  search_path TEXT NOT NULL CHECK(search_path IN ('object','scene','activity','author')),
  hypothesis TEXT NOT NULL, language TEXT NOT NULL, query_text TEXT NOT NULL,
  checked_result_count INTEGER NOT NULL DEFAULT 0 CHECK(checked_result_count>=0),
  new_source_count INTEGER NOT NULL DEFAULT 0 CHECK(new_source_count>=0),
  valid_lead_count INTEGER NOT NULL DEFAULT 0 CHECK(valid_lead_count>=0),
  parent_source_id TEXT REFERENCES sources(source_id),
  adapter_version TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count>=0),
  coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
  status TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL, canonical_key TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'LEAD_UNVERIFIED' CHECK(verification_state IN ('LEAD_UNVERIFIED','PAGE_VERIFIED','DISPUTED')),
  route_state TEXT NOT NULL DEFAULT 'NEEDS_ROUTE_DISCOVERY' CHECK(route_state IN ('READY','PENDING_RETRY','NEEDS_ROUTE_DISCOVERY','NEEDS_APPROVAL','KNOWN_BLOCKED')),
  canonical_url TEXT NOT NULL, platform_item_id TEXT,
  media_kind TEXT NOT NULL CHECK(media_kind IN ('VIDEO','IMAGE')),
  title TEXT, uploader_json TEXT NOT NULL CHECK(json_valid(uploader_json)),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  capture_evidence_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(capture_evidence_state IN ('UNKNOWN','SUPPORTED','SYNTHETIC_EVIDENCE','DISPUTED')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(platform_id,canonical_key)
);
CREATE TABLE task_sources (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  first_discovery_id TEXT REFERENCES source_discoveries(discovery_id),
  PRIMARY KEY(task_id,source_id)
);
CREATE TABLE source_relations (
  relation_id TEXT PRIMARY KEY,
  left_source_id TEXT NOT NULL REFERENCES sources(source_id),
  right_source_id TEXT NOT NULL REFERENCES sources(source_id),
  relation_type TEXT NOT NULL CHECK(relation_type IN ('REPOST','PARTIAL_OVERLAP','SAME_PROJECT','POSSIBLE_MATCH')),
  status TEXT NOT NULL CHECK(status IN ('SUGGESTED','CONFIRMED','REJECTED')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  overlap_json TEXT NOT NULL CHECK(json_valid(overlap_json)),
  CHECK(left_source_id<>right_source_id)
);
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(task_id),
  task_revision INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('search.execute','source.inspect','media.acquire','media.probe','media.overview','media.sample','frame.assess','frame.dedupe','batch.prepare','batch.export','maintenance.backup','search.plan','source.route','source.capture','media.relocate','frame.tile','media.overlap','frame.select','feedback.apply','image.normalize')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','WAITING_AGENT','WAITING_APPROVAL','BLOCKED','SUCCEEDED','FAILED','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
  worker_id TEXT, lease_token_sha256 TEXT, lease_expires_at TEXT, heartbeat_at TEXT,
  completion_scope TEXT CHECK(completion_scope IN ('FULL','PARTIAL')),
  unprocessed_inputs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(unprocessed_inputs_json)),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(progress_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE INDEX jobs_ready_idx ON jobs(status,created_at);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(job_id),
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  mime_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK(synthetic IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE media (
  media_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(artifact_id),
  media_kind TEXT NOT NULL CHECK(media_kind IN ('VIDEO','IMAGE')),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64),
  state TEXT NOT NULL CHECK(state IN ('ACQUIRED','VERIFIED','CORRUPT','NEEDS_MEDIA_REVIEW')),
  width INTEGER CHECK(width>0), height INTEGER CHECK(height>0),
  duration_s REAL CHECK(duration_s>=0),
  probe_json TEXT NOT NULL CHECK(json_valid(probe_json)),
  decode_scope_json TEXT NOT NULL CHECK(json_valid(decode_scope_json)),
  created_at TEXT NOT NULL,
  CHECK(media_kind='VIDEO' OR duration_s IS NULL)
);
CREATE TABLE media_origins (
  origin_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(media_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  version_kind TEXT NOT NULL CHECK(version_kind IN ('AUTHOR_ORIGINAL','PLATFORM_TRANSCODE','PUBLISHED_IMAGE','LICENSED_FILE','UNKNOWN')),
  variant_id TEXT NOT NULL REFERENCES source_variants(variant_id),
  acquisition_method TEXT NOT NULL,
  retrieval_url_redacted TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL REFERENCES policy_decisions(decision_id),
  retrieved_at TEXT NOT NULL,
  UNIQUE(media_id,source_id,version_kind)
);
CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  media_id TEXT NOT NULL REFERENCES media(media_id),
  stream_index INTEGER NOT NULL CHECK(stream_index>=0),
  start_pts INTEGER NOT NULL, end_pts INTEGER NOT NULL,
  time_base_num INTEGER NOT NULL CHECK(time_base_num>0),
  time_base_den INTEGER NOT NULL CHECK(time_base_den>0),
  evidence_mode TEXT NOT NULL CHECK(evidence_mode IN ('NAVIGATION_CANDIDATE','SAMPLED_OBSERVATIONS','CONTINUOUS_REVIEW')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  CHECK(end_pts>=start_pts)
);
CREATE TABLE frames (
  frame_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(media_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  frame_kind TEXT NOT NULL CHECK(frame_kind IN ('VIDEO_FRAME','STILL_IMAGE')),
  stream_index INTEGER NOT NULL CHECK(stream_index>=0),
  pts INTEGER,
  frame_identity_sha256 TEXT NOT NULL UNIQUE CHECK(length(frame_identity_sha256)=64),
  decode_ordinal INTEGER NOT NULL CHECK(decode_ordinal>=0),
  time_base_num INTEGER CHECK(time_base_num>0),
  time_base_den INTEGER CHECK(time_base_den>0),
  time_origin_pts INTEGER,
  actual_time_s REAL,
  width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
  transform_json TEXT NOT NULL CHECK(json_valid(transform_json)),
  transform_sha256 TEXT NOT NULL CHECK(length(transform_sha256)=64),
  pixel_sha256 TEXT CHECK(pixel_sha256 IS NULL OR length(pixel_sha256)=64),
  quality_json TEXT NOT NULL CHECK(json_valid(quality_json)),
  created_at TEXT NOT NULL,
  CHECK((pts IS NULL AND time_base_num IS NULL AND time_base_den IS NULL AND time_origin_pts IS NULL AND actual_time_s IS NULL) OR (pts IS NOT NULL AND time_base_num IS NOT NULL AND time_base_den IS NOT NULL AND time_origin_pts IS NOT NULL AND actual_time_s IS NOT NULL)),
  CHECK(frame_kind='VIDEO_FRAME' OR (pts IS NULL AND stream_index=0 AND decode_ordinal=0)),
  UNIQUE(media_id,stream_index,pts,transform_sha256)
);
CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
  source_id TEXT REFERENCES sources(source_id), frame_id TEXT REFERENCES frames(frame_id),
  actor_id TEXT NOT NULL,
  case_set_version INTEGER NOT NULL CHECK(case_set_version>=1),
  analysis_level TEXT NOT NULL CHECK(analysis_level IN ('navigation','native','roi')),
  delivery_id TEXT REFERENCES asset_deliveries(delivery_id),
  supersedes_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(supersedes_json)),
  conflicts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(conflicts_json)),
  method TEXT NOT NULL CHECK(method IN ('HOST_AGENT','API_VISION','HUMAN_OBSERVATION','TECHNICAL_TOOL')),
  target_state TEXT NOT NULL CHECK(target_state IN ('NOT_CHECKED','PRESENT','ABSENT_IN_CHECKED_VIEW','UNCERTAIN','UNREADABLE')),
  viewpoint_state TEXT NOT NULL CHECK(viewpoint_state IN ('NOT_CHECKED','MATCH','MISMATCH','UNCERTAIN')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  implementation_version TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK(source_id IS NOT NULL OR frame_id IS NOT NULL),
  FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE similarity_links (
  link_id TEXT PRIMARY KEY,
  left_frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  right_frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  relation_type TEXT NOT NULL CHECK(relation_type IN ('EXACT','NEAR','SAME_PHOTO_VARIANT','CROP_OF')),
  status TEXT NOT NULL CHECK(status IN ('SUGGESTED','CONFIRMED','REJECTED')),
  metric_json TEXT NOT NULL CHECK(json_valid(metric_json)),
  CHECK(left_frame_id<>right_frame_id), UNIQUE(left_frame_id,right_frame_id,relation_type)
);
CREATE TABLE policy_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(task_id), source_id TEXT REFERENCES sources(source_id),
  action TEXT NOT NULL CHECK(action IN ('search','preview','save_evidence','acquire','process_local','share_external_model','train_use','redistribute')),
  proposed_basis TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  status TEXT NOT NULL CHECK(status IN ('PENDING','DECIDED','WITHDRAWN')),
  created_at TEXT NOT NULL
);
CREATE TABLE policy_decisions (
  decision_id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES policy_requests(request_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('UNKNOWN','ALLOW','CONDITIONAL','DENY')),
  conditions_satisfied INTEGER NOT NULL CHECK(conditions_satisfied IN (0,1)),
  approver_id TEXT NOT NULL, basis_json TEXT NOT NULL CHECK(json_valid(basis_json)),
  standing_rule_id TEXT REFERENCES policy_rules(rule_id), rule_version INTEGER,
  action TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  external_basis_state TEXT NOT NULL CHECK(external_basis_state IN ('UNREVIEWED','SUPPORTED','NOT_APPLICABLE','CONTRADICTED')),
  expires_at TEXT, created_at TEXT NOT NULL,
  CHECK(request_id IS NOT NULL OR standing_rule_id IS NOT NULL),
  CHECK(standing_rule_id IS NULL OR rule_version>=1)
);
CREATE TABLE agent_requests (
  request_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  request_type TEXT NOT NULL CHECK(request_type IN ('PLAN_SEARCH','SEARCH_QUERY','VERIFY_PREVIEW','FIND_ACQUIRE_ROUTE','NAVIGATE_MEDIA','REVIEW_FRAME_BATCH','SELECT_REPRESENTATIVES','APPLY_FEEDBACK')),
  task_revision INTEGER NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL CHECK(status IN ('PENDING','CLAIMED','RESPONDED','BLOCKED','EXPIRED','CANCELLED')),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  claimed_by TEXT, claim_expires_at TEXT,
  claim_token_sha256 TEXT CHECK(claim_token_sha256 IS NULL OR length(claim_token_sha256)=64),
  claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
  case_set_version INTEGER NOT NULL DEFAULT 1 CHECK(case_set_version>=1),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE review_batches (
  batch_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','REVIEWED','EXPORTED','SUPERSEDED')),
  selection_id TEXT NOT NULL REFERENCES frame_selections(selection_id),
  audit_seed INTEGER NOT NULL, blind_audit INTEGER NOT NULL CHECK(blind_audit IN (0,1)),
  audit_shortfall INTEGER NOT NULL DEFAULT 0 CHECK(audit_shortfall>=0),
  context_digest TEXT NOT NULL CHECK(length(context_digest)=64),
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE review_items (
  batch_id TEXT NOT NULL REFERENCES review_batches(batch_id),
  frame_id TEXT NOT NULL REFERENCES frames(frame_id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  suggestion_json TEXT NOT NULL CHECK(json_valid(suggestion_json)),
  item_kind TEXT NOT NULL CHECK(item_kind IN ('CANDIDATE','AUDIT_REJECTED','UNCERTAIN')),
  selection_id TEXT NOT NULL REFERENCES frame_selections(selection_id),
  representative_group_id TEXT,
  PRIMARY KEY(batch_id,frame_id)
);
CREATE TABLE review_decisions (
  review_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL, frame_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  decision TEXT NOT NULL CHECK(decision IN ('ACCEPT','REJECT','REWORK')),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('ACCEPTED','WRONG_OBJECT','NOT_AERIAL','TOO_SMALL','UNREADABLE','DUPLICATE','NO_NEW_SCENE','SOURCE_UNCERTAIN','POLICY_PENDING','OTHER')), comment TEXT NOT NULL,
  business_quality_confirmed INTEGER NOT NULL CHECK(business_quality_confirmed IN (0,1)),
  review_context_digest TEXT NOT NULL CHECK(length(review_context_digest)=64),
  auth_event_id TEXT NOT NULL REFERENCES reviewer_auth_events(auth_event_id),
  reviewer_id TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(batch_id,frame_id) REFERENCES review_items(batch_id,frame_id),
  CHECK(decision<>'ACCEPT' OR business_quality_confirmed=1),
  UNIQUE(batch_id,frame_id,revision)
);
CREATE TABLE exports (
  export_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  batch_id TEXT NOT NULL REFERENCES review_batches(batch_id),
  export_kind TEXT NOT NULL CHECK(export_kind IN ('review_package','accepted_material')),
  manifest_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)), created_at TEXT NOT NULL
);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit append-only'); END;
CREATE TRIGGER review_decisions_no_update BEFORE UPDATE ON review_decisions BEGIN SELECT RAISE(ABORT,'review append-only'); END;
CREATE TRIGGER review_decisions_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'review append-only'); END;
CREATE TRIGGER observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'observations append-only'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'observations append-only'); END;
-- Service-layer mandatory checks: same-task references; time/coordinate bounds;
-- role-derived actor; policy validity; lease fencing; all export eligibility gates.
-- DDL alone is NOT a complete authorization or business-state implementation.
CREATE TABLE content_groups (
  group_id TEXT PRIMARY KEY,
  group_kind TEXT NOT NULL CHECK(group_kind IN ('FOOTAGE_FAMILY','SCENE_GROUP')),
  evidence_state TEXT NOT NULL CHECK(evidence_state IN ('SUGGESTED','SUPPORTED','DISPUTED')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL
);
CREATE TABLE content_group_members (
  member_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES content_groups(group_id),
  source_id TEXT REFERENCES sources(source_id),
  media_id TEXT REFERENCES media(media_id),
  segment_id TEXT REFERENCES segments(segment_id),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  CHECK(source_id IS NOT NULL OR media_id IS NOT NULL OR segment_id IS NOT NULL)
);
CREATE TABLE policy_rules (
  rule_id TEXT PRIMARY KEY, rule_version INTEGER NOT NULL CHECK(rule_version>=1),
  rule_json TEXT NOT NULL CHECK(json_valid(rule_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  approved_by TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE budget_reservations (
  reservation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  job_id TEXT REFERENCES jobs(job_id),
  resource_key TEXT NOT NULL,
  reserved_units INTEGER NOT NULL CHECK(reserved_units>=0),
  settled_units INTEGER CHECK(settled_units>=0),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','SETTLED','RELEASED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- resource_key fixes the unit: file_bytes, decoded_milliseconds,
-- external_cost_micro_usd, query_count, frame_count, etc. No floating currency.
CREATE TABLE capability_checks (
  check_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL,
  operation TEXT NOT NULL, implementation_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('UNCONFIGURED','AVAILABLE','BLOCKED','UNSUPPORTED')),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), checked_at TEXT NOT NULL
);
CREATE TRIGGER task_revisions_no_update BEFORE UPDATE ON task_revisions BEGIN SELECT RAISE(ABORT,'task revisions append-only'); END;
CREATE TRIGGER task_revisions_no_delete BEFORE DELETE ON task_revisions BEGIN SELECT RAISE(ABORT,'task revisions append-only'); END;
CREATE TRIGGER policy_decisions_no_update BEFORE UPDATE ON policy_decisions BEGIN SELECT RAISE(ABORT,'policy decisions append-only'); END;
CREATE TRIGGER policy_decisions_no_delete BEFORE DELETE ON policy_decisions BEGIN SELECT RAISE(ABORT,'policy decisions append-only'); END;

-- v1.1 additions: query/discovery history is independent of task membership.
CREATE TABLE search_queries (
 query_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
 query_json TEXT NOT NULL CHECK(json_valid(query_json)), plan_id TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE source_discoveries (
 discovery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), source_id TEXT NOT NULL REFERENCES sources(source_id),
 search_run_id TEXT REFERENCES search_runs(search_run_id), query_id TEXT REFERENCES search_queries(query_id),
 adapter_id TEXT NOT NULL, platform_id TEXT NOT NULL, client_discovery_id TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL,
 UNIQUE(task_id,client_discovery_id)
);
CREATE TABLE source_verifications (
 verification_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
 method TEXT NOT NULL CHECK(method IN ('ADAPTER_METADATA','BROWSER_CAPTURE','USER_SUPPLIED_RECORD')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), verified_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE source_variants (
 variant_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), adapter_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('DISCOVERED','VERIFIED','EXPIRED','BLOCKED')),
 width INTEGER CHECK(width>0), height INTEGER CHECK(height>0), duration_s REAL CHECK(duration_s>=0), bytes INTEGER CHECK(bytes>=0),
 bitrate_bps INTEGER CHECK(bitrate_bps>=0), mime_type TEXT, locator_key TEXT NOT NULL,
 url_redacted TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 discovered_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE route_assessments (
 route_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), task_id TEXT NOT NULL REFERENCES tasks(task_id),
 state TEXT NOT NULL CHECK(state IN ('READY','PENDING_RETRY','NEEDS_ROUTE_DISCOVERY','NEEDS_APPROVAL','KNOWN_BLOCKED')),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), steps_used INTEGER NOT NULL CHECK(steps_used>=0),
 retry_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE capture_assessments (
 assessment_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id), media_id TEXT REFERENCES media(media_id),
 proposed_state TEXT NOT NULL CHECK(proposed_state IN ('UNKNOWN','SUPPORTED','SYNTHETIC_EVIDENCE','DISPUTED')),
 basis_kind TEXT NOT NULL CHECK(basis_kind IN ('UPLOADER_CLAIM','INDEPENDENT_SOURCE_RECORD','ACQUISITION_PROVENANCE','CONTRADICTORY_RECORD','VISUAL_ONLY')),
 content_kind TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(content_kind IN ('CAMERA_CAPTURE','VIDEO_DERIVED','ORTHOMOSAIC','SCREENSHOT','UNKNOWN')),
 proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 CHECK(basis_kind<>'VISUAL_ONLY' OR proposed_state<>'SUPPORTED')
);
CREATE TABLE capture_decisions (
 decision_id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES capture_assessments(assessment_id),
 decision TEXT NOT NULL CHECK(decision IN ('CONFIRM','REJECT','NEEDS_MORE')), basis TEXT NOT NULL,
 reviewer_id TEXT NOT NULL, auth_event_id TEXT NOT NULL REFERENCES reviewer_auth_events(auth_event_id), created_at TEXT NOT NULL
);
CREATE TABLE capture_exceptions (
 exception_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
 frame_ids_json TEXT NOT NULL CHECK(json_valid(frame_ids_json)), reason TEXT NOT NULL, reviewer_id TEXT NOT NULL,
 auth_event_id TEXT NOT NULL REFERENCES reviewer_auth_events(auth_event_id), expires_at TEXT, created_at TEXT NOT NULL,
 FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE quality_assessments (
 assessment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
 frame_id TEXT NOT NULL REFERENCES frames(frame_id), dimension TEXT NOT NULL CHECK(dimension IN ('technical','business')),
 state TEXT NOT NULL CHECK(state IN ('NOT_CHECKED','USABLE','UNCERTAIN','REJECTED')), actor_id TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE observation_resolutions (
 resolution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), frame_id TEXT NOT NULL REFERENCES frames(frame_id),
 resolution_json TEXT NOT NULL CHECK(json_valid(resolution_json)), reviewer_id TEXT NOT NULL,
 auth_event_id TEXT NOT NULL REFERENCES reviewer_auth_events(auth_event_id), created_at TEXT NOT NULL
);
CREATE TABLE user_references (
 reference_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
 role TEXT NOT NULL CHECK(role IN ('positive','negative','boundary','context')), description TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE task_feedback (
 feedback_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
 feedback_json TEXT NOT NULL CHECK(json_valid(feedback_json)),
 status TEXT NOT NULL CHECK(status IN ('PENDING','ASSESSING','AWAITING_CONFIRMATION','APPLIED','BLOCKED')),
 case_set_version INTEGER NOT NULL CHECK(case_set_version>=1), created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE feedback_impact_events (
 impact_event_id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL REFERENCES task_feedback(feedback_id),
 impact TEXT NOT NULL CHECK(impact IN ('NO_SEMANTIC_CHANGE','TARGETED_RECHECK','DEFINITION_CHANGE','UNKNOWN')),
 impact_json TEXT NOT NULL CHECK(json_valid(impact_json)), actor_id TEXT NOT NULL,
 confirmed_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE observation_applicability (
 applicability_id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES observations(observation_id),
 task_revision INTEGER NOT NULL, case_set_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('APPLICABLE','NEEDS_RECHECK','SUPERSEDED')),
 reason TEXT NOT NULL, impact_event_id TEXT REFERENCES feedback_impact_events(impact_event_id), created_at TEXT NOT NULL
);
CREATE TABLE frame_segments (
 frame_id TEXT NOT NULL REFERENCES frames(frame_id), segment_id TEXT NOT NULL REFERENCES segments(segment_id),
 PRIMARY KEY(frame_id,segment_id)
);
CREATE TABLE media_overlaps (
 relation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id),
 left_segment_id TEXT NOT NULL REFERENCES segments(segment_id), right_segment_id TEXT NOT NULL REFERENCES segments(segment_id),
 status TEXT NOT NULL CHECK(status IN ('SUGGESTED','CONFIRMED','REJECTED')),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL,
 CHECK(left_segment_id<>right_segment_id)
);
CREATE TABLE coverage_events (
 coverage_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), media_id TEXT NOT NULL REFERENCES media(media_id),
 job_id TEXT NOT NULL REFERENCES jobs(job_id),
 kind TEXT NOT NULL CHECK(kind IN ('DECODED','SAMPLED','DELIVERED','VISUALLY_REVIEWED','HUMAN_REVIEWED')),
 coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)), created_at TEXT NOT NULL
);
CREATE TABLE derived_assets (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(artifact_id), parent_frame_id TEXT NOT NULL REFERENCES frames(frame_id),
 crop_json TEXT NOT NULL CHECK(json_valid(crop_json)), mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)),
 width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 analysis_level TEXT NOT NULL CHECK(analysis_level IN ('navigation','native','roi'))
);
CREATE TABLE asset_deliveries (
 delivery_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES agent_requests(request_id),
 claim_generation INTEGER NOT NULL CHECK(claim_generation>0), asset_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(request_id,claim_generation,asset_id)
);
CREATE TABLE delivery_receipts (
 receipt_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES asset_deliveries(delivery_id),
 authenticated_actor_id TEXT NOT NULL, delivery_sha256 TEXT NOT NULL CHECK(length(delivery_sha256)=64),
 method TEXT NOT NULL CHECK(method IN ('LOCAL_READ_HANDOFF','HTTP_DELIVERY','HOST_CAPTURE_HANDOFF')),
 created_at TEXT NOT NULL
);
CREATE TABLE job_dependencies (
 job_id TEXT NOT NULL REFERENCES jobs(job_id), depends_on_job_id TEXT NOT NULL REFERENCES jobs(job_id),
 PRIMARY KEY(job_id,depends_on_job_id), CHECK(job_id<>depends_on_job_id)
);
CREATE TABLE workflow_events (
 event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), parent_job_id TEXT REFERENCES jobs(job_id),
 event_type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 idempotency_key TEXT NOT NULL UNIQUE, dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('PENDING','DONE','BLOCKED')),
 created_at TEXT NOT NULL, dispatched_at TEXT
);
CREATE TABLE entity_reservations (
 reservation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(job_id), attempt INTEGER NOT NULL CHECK(attempt>=1),
 kind TEXT NOT NULL, entity_id TEXT NOT NULL UNIQUE, client_key TEXT NOT NULL,
 UNIQUE(job_id,attempt,client_key)
);
CREATE TABLE frame_selections (
 selection_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), task_revision INTEGER NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(task_id,task_revision) REFERENCES task_revisions(task_id,revision)
);
CREATE TABLE reviewer_accounts (
 reviewer_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
);
CREATE TABLE reviewer_sessions (
 session_id_sha256 TEXT PRIMARY KEY CHECK(length(session_id_sha256)=64), reviewer_id TEXT NOT NULL REFERENCES reviewer_accounts(reviewer_id),
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE reviewer_auth_events (
 auth_event_id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewer_accounts(reviewer_id),
 operation TEXT NOT NULL, subject_id TEXT NOT NULL, subject_digest TEXT NOT NULL CHECK(length(subject_digest)=64),
 authenticated_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE bootstrap_events (
 event_id TEXT PRIMARY KEY, config_revision INTEGER NOT NULL CHECK(config_revision>=1),
 reviewer_id TEXT NOT NULL REFERENCES reviewer_accounts(reviewer_id),
 auth_event_id TEXT NOT NULL REFERENCES reviewer_auth_events(auth_event_id),
 rule_ids_json TEXT NOT NULL CHECK(json_valid(rule_ids_json)), created_at TEXT NOT NULL
);
CREATE INDEX discoveries_source_idx ON source_discoveries(task_id,source_id);
CREATE INDEX agent_pending_idx ON agent_requests(status,created_at);
CREATE INDEX workflow_pending_idx ON workflow_events(dispatch_state,created_at);
CREATE INDEX coverage_media_idx ON coverage_events(media_id,kind);
CREATE INDEX frames_media_pts_idx ON frames(media_id,stream_index,pts);
CREATE TRIGGER frames_kind_insert BEFORE INSERT ON frames
WHEN COALESCE((SELECT kind FROM artifacts WHERE artifact_id=NEW.artifact_id),'')<>'frame'
BEGIN SELECT RAISE(ABORT,'frame must reference frame artifact'); END;
CREATE TRIGGER frames_kind_update BEFORE UPDATE OF artifact_id ON frames
WHEN COALESCE((SELECT kind FROM artifacts WHERE artifact_id=NEW.artifact_id),'')<>'frame'
BEGIN SELECT RAISE(ABORT,'frame must reference frame artifact'); END;
CREATE TRIGGER frames_media_kind_insert BEFORE INSERT ON frames
WHEN (NEW.frame_kind='STILL_IMAGE') <> (COALESCE((SELECT media_kind FROM media WHERE media_id=NEW.media_id),'')='IMAGE')
BEGIN SELECT RAISE(ABORT,'frame_kind must match media_kind'); END;
CREATE TRIGGER frames_media_kind_update BEFORE UPDATE OF frame_kind,media_id ON frames
WHEN (NEW.frame_kind='STILL_IMAGE') <> (COALESCE((SELECT media_kind FROM media WHERE media_id=NEW.media_id),'')='IMAGE')
BEGIN SELECT RAISE(ABORT,'frame_kind must match media_kind'); END;
CREATE TRIGGER media_kind_no_update BEFORE UPDATE OF media_kind ON media BEGIN SELECT RAISE(ABORT,'media_kind is immutable'); END;
CREATE TRIGGER media_kind_insert BEFORE INSERT ON media
WHEN COALESCE((SELECT kind FROM artifacts WHERE artifact_id=NEW.artifact_id),'')<>'media'
BEGIN SELECT RAISE(ABORT,'media must reference media artifact'); END;
CREATE TRIGGER source_discoveries_no_update BEFORE UPDATE ON source_discoveries BEGIN SELECT RAISE(ABORT,'source_discoveries append-only'); END;
CREATE TRIGGER source_discoveries_no_delete BEFORE DELETE ON source_discoveries BEGIN SELECT RAISE(ABORT,'source_discoveries append-only'); END;
CREATE TRIGGER source_verifications_no_update BEFORE UPDATE ON source_verifications BEGIN SELECT RAISE(ABORT,'source_verifications append-only'); END;
CREATE TRIGGER source_verifications_no_delete BEFORE DELETE ON source_verifications BEGIN SELECT RAISE(ABORT,'source_verifications append-only'); END;
CREATE TRIGGER capture_assessments_no_update BEFORE UPDATE ON capture_assessments BEGIN SELECT RAISE(ABORT,'capture_assessments append-only'); END;
CREATE TRIGGER capture_assessments_no_delete BEFORE DELETE ON capture_assessments BEGIN SELECT RAISE(ABORT,'capture_assessments append-only'); END;
CREATE TRIGGER capture_decisions_no_update BEFORE UPDATE ON capture_decisions BEGIN SELECT RAISE(ABORT,'capture_decisions append-only'); END;
CREATE TRIGGER capture_decisions_no_delete BEFORE DELETE ON capture_decisions BEGIN SELECT RAISE(ABORT,'capture_decisions append-only'); END;
CREATE TRIGGER capture_exceptions_no_update BEFORE UPDATE ON capture_exceptions BEGIN SELECT RAISE(ABORT,'capture_exceptions append-only'); END;
CREATE TRIGGER capture_exceptions_no_delete BEFORE DELETE ON capture_exceptions BEGIN SELECT RAISE(ABORT,'capture_exceptions append-only'); END;
CREATE TRIGGER quality_assessments_no_update BEFORE UPDATE ON quality_assessments BEGIN SELECT RAISE(ABORT,'quality_assessments append-only'); END;
CREATE TRIGGER quality_assessments_no_delete BEFORE DELETE ON quality_assessments BEGIN SELECT RAISE(ABORT,'quality_assessments append-only'); END;
CREATE TRIGGER observation_resolutions_no_update BEFORE UPDATE ON observation_resolutions BEGIN SELECT RAISE(ABORT,'observation_resolutions append-only'); END;
CREATE TRIGGER observation_resolutions_no_delete BEFORE DELETE ON observation_resolutions BEGIN SELECT RAISE(ABORT,'observation_resolutions append-only'); END;
CREATE TRIGGER feedback_impact_events_no_update BEFORE UPDATE ON feedback_impact_events BEGIN SELECT RAISE(ABORT,'feedback_impact_events append-only'); END;
CREATE TRIGGER feedback_impact_events_no_delete BEFORE DELETE ON feedback_impact_events BEGIN SELECT RAISE(ABORT,'feedback_impact_events append-only'); END;
CREATE TRIGGER observation_applicability_no_update BEFORE UPDATE ON observation_applicability BEGIN SELECT RAISE(ABORT,'observation_applicability append-only'); END;
CREATE TRIGGER observation_applicability_no_delete BEFORE DELETE ON observation_applicability BEGIN SELECT RAISE(ABORT,'observation_applicability append-only'); END;
CREATE TRIGGER coverage_events_no_update BEFORE UPDATE ON coverage_events BEGIN SELECT RAISE(ABORT,'coverage_events append-only'); END;
CREATE TRIGGER coverage_events_no_delete BEFORE DELETE ON coverage_events BEGIN SELECT RAISE(ABORT,'coverage_events append-only'); END;
CREATE TRIGGER delivery_receipts_no_update BEFORE UPDATE ON delivery_receipts BEGIN SELECT RAISE(ABORT,'delivery_receipts append-only'); END;
CREATE TRIGGER delivery_receipts_no_delete BEFORE DELETE ON delivery_receipts BEGIN SELECT RAISE(ABORT,'delivery_receipts append-only'); END;
CREATE TRIGGER reviewer_auth_events_no_update BEFORE UPDATE ON reviewer_auth_events BEGIN SELECT RAISE(ABORT,'reviewer_auth_events append-only'); END;
CREATE TRIGGER reviewer_auth_events_no_delete BEFORE DELETE ON reviewer_auth_events BEGIN SELECT RAISE(ABORT,'reviewer_auth_events append-only'); END;
CREATE TRIGGER bootstrap_events_no_update BEFORE UPDATE ON bootstrap_events BEGIN SELECT RAISE(ABORT,'bootstrap_events append-only'); END;
CREATE TRIGGER bootstrap_events_no_delete BEFORE DELETE ON bootstrap_events BEGIN SELECT RAISE(ABORT,'bootstrap_events append-only'); END;

-- Credentials, actual resource integrity, expiry/reauth, source authenticity, semantic correctness, and export eligibility are NOT proved by DDL.
