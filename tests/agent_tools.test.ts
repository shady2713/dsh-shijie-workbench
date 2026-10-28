import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadContracts } from '../src/contracts.ts'
import { Workbench } from '../src/domain/workbench.ts'
import { Store } from '../src/store.ts'
import { canonicalJson, DomainError, nowIso, sha256Hex } from '../src/util.ts'
import { activeSpec, sourceInput } from './helpers.ts'

type Dict = Record<string, any>

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'NO_ERROR'
}

function insertArtifact(wb: Workbench, id: string, path = `artifacts/${id}/file.png`, kind = 'screenshot', metadata: Dict = {}): string {
  wb.store.run(
    'insert into artifacts(artifact_id,job_id,kind,relative_path,sha256,bytes,mime_type,metadata_json,synthetic,created_at) values (?,?,?,?,?,?,?,?,0,?)',
    id, null, kind, path, sha256Hex(id), 10, 'image/png', JSON.stringify(metadata), nowIso(),
  )
  return id
}

function insertMedia(wb: Workbench, mediaId: string, artifactId: string, kind: 'VIDEO' | 'IMAGE' = 'IMAGE'): string {
  wb.store.run(
    'insert into media(media_id,artifact_id,media_kind,sha256,state,width,height,duration_s,probe_json,decode_scope_json,created_at) values (?,?,?,?,?,?,?,?,?,?,?)',
    mediaId, artifactId, kind, sha256Hex(mediaId), 'VERIFIED', 1920, 1080, kind === 'VIDEO' ? 12.5 : null, '{}', '{}', nowIso(),
  )
  return mediaId
}

function insertFrame(wb: Workbench, frameId: string, mediaId: string, kind: 'VIDEO_FRAME' | 'STILL_IMAGE' = 'STILL_IMAGE'): string {
  wb.store.run(
    `insert into frames(frame_id,media_id,artifact_id,frame_kind,stream_index,pts,frame_identity_sha256,decode_ordinal,time_base_num,time_base_den,time_origin_pts,actual_time_s,width,height,transform_json,transform_sha256,quality_json,created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    frameId, mediaId, `art_${frameId}`, kind, 0, kind === 'VIDEO_FRAME' ? 120 : null, sha256Hex(frameId), 0,
    kind === 'VIDEO_FRAME' ? 1 : null, kind === 'VIDEO_FRAME' ? 30 : null, kind === 'VIDEO_FRAME' ? 0 : null,
    kind === 'VIDEO_FRAME' ? 4 : null, 1920, 1080, '{}', sha256Hex(`t${frameId}`), '{}', nowIso(),
  )
  return frameId
}

function insertObservation(wb: Workbench, observationId: string, taskId: string, frameId: string, over: Dict = {}): string {
  wb.store.run(
    `insert into observations(observation_id,task_id,task_revision,source_id,frame_id,actor_id,case_set_version,analysis_level,delivery_id,supersedes_json,conflicts_json,method,target_state,viewpoint_state,evidence_json,result_json,implementation_version,created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    observationId, taskId, 1, null, frameId, 'agent', 1, 'native', null, '[]', '[]', 'HOST_AGENT',
    over.target_state ?? 'PRESENT', over.viewpoint_state ?? 'MATCH', '{}', '{}', 'test/1', nowIso(),
  )
  return observationId
}

function insertQuality(wb: Workbench, id: string, taskId: string, frameId: string, dimension: string, state: string): string {
  wb.store.run(
    'insert into quality_assessments(assessment_id,task_id,task_revision,frame_id,dimension,state,actor_id,evidence_json,created_at) values (?,?,?,?,?,?,?,?,?)',
    id, taskId, 1, frameId, dimension, state, 'agent', JSON.stringify({ reason: 'fixture' }), nowIso(),
  )
  return id
}

interface Fixture {
  dir: string
  wb: Workbench
  taskId: string
  sourceId: string
  artifactId: string
  mediaId: string
  frameId: string
  segmentA: string
  segmentB: string
  batchId: string
  exportId: string
  feedbackId: string
}

let fx: Fixture

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'shijie-agent-'))
  const wb = new Workbench({
    store: new Store({ path: ':memory:' }),
    contracts: loadContracts(),
    mode: 'assisted',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    dataDir: dir,
  })
  const taskId = wb.createTask(activeSpec(), 'agent').summary.task_id
  const sourceId = wb.registerSource(sourceInput(taskId), 'agent').source.source_id
  const artifactId = insertArtifact(wb, 'art_evidence', 'artifacts/art_evidence/file.png', 'screenshot', { source_id: sourceId })
  insertArtifact(wb, 'art_media_1', 'artifacts/art_media_1/frame.png', 'media')
  insertArtifact(wb, 'art_frame_1', 'artifacts/art_frame_1/frame.png', 'frame')
  const mediaId = insertMedia(wb, 'media_1', 'art_media_1')
  const frameId = insertFrame(wb, 'frame_1', mediaId)
  insertQuality(wb, 'qa_tech', taskId, frameId, 'technical', 'USABLE')
  insertQuality(wb, 'qa_biz', taskId, frameId, 'business', 'USABLE')

  // Source state needed for review readiness.
  wb.store.run("update sources set verification_state='PAGE_VERIFIED', capture_evidence_state='SUPPORTED', route_state='READY' where source_id=?", sourceId)

  // Media segment rows and overlap.
  wb.store.run(
    'insert into segments(segment_id,task_id,media_id,stream_index,start_pts,end_pts,time_base_num,time_base_den,evidence_mode,evidence_json) values (?,?,?,?,?,?,?,?,?,?)',
    'seg_a', taskId, mediaId, 0, 0, 100, 1, 30, 'SAMPLED_OBSERVATIONS', JSON.stringify({ observation_ids: ['obs_1'] }),
  )
  wb.store.run(
    'insert into segments(segment_id,task_id,media_id,stream_index,start_pts,end_pts,time_base_num,time_base_den,evidence_mode,evidence_json) values (?,?,?,?,?,?,?,?,?,?)',
    'seg_b', taskId, mediaId, 0, 50, 150, 1, 30, 'SAMPLED_OBSERVATIONS', JSON.stringify({ observation_ids: [] }),
  )
  wb.store.run('insert into frame_segments(frame_id,segment_id) values (?,?)', frameId, 'seg_a')
  wb.store.run(
    'insert into media_overlaps(relation_id,task_id,left_segment_id,right_segment_id,status,evidence_json,created_at) values (?,?,?,?,?,?,?)',
    'rel_1', taskId, 'seg_a', 'seg_b', 'SUGGESTED', JSON.stringify({ evidence_asset_ids: ['art_evidence'], method: 'visual' }), nowIso(),
  )

  // Review batch and item.
  wb.store.run(
    'insert into frame_selections(selection_id,task_id,task_revision,result_json,created_at) values (?,?,?,?,?)',
    'sel_1', taskId, 1, '{}', nowIso(),
  )
  wb.store.run(
    'insert into review_batches(batch_id,task_id,task_revision,status,selection_id,audit_seed,blind_audit,audit_shortfall,context_digest,created_at) values (?,?,?,?,?,?,?,?,?,?)',
    'batch_1', taskId, 1, 'OPEN', 'sel_1', 7, 1, 0, sha256Hex('ctx'), nowIso(),
  )
  wb.store.run(
    'insert into review_items(batch_id,frame_id,revision,suggestion_json,item_kind,selection_id,representative_group_id) values (?,?,?,?,?,?,?)',
    'batch_1', frameId, 1, '{}', 'CANDIDATE', 'sel_1', 'grp_1',
  )

  // Export with a manifest artifact.
  insertArtifact(wb, 'art_manifest', 'exports/manifest.json')
  wb.store.run(
    'insert into exports(export_id,task_id,batch_id,export_kind,manifest_artifact_id,snapshot_json,created_at) values (?,?,?,?,?,?,?)',
    'exp_1', taskId, 'batch_1', 'review_package', 'art_manifest',
    JSON.stringify({ artifact_ids: ['art_manifest'], included_frame_ids: [frameId], excluded: [] }), nowIso(),
  )

  // Feedback.
  wb.store.run(
    'insert into task_feedback(feedback_id,task_id,feedback_json,status,case_set_version,created_by,created_at) values (?,?,?,?,?,?,?)',
    'fb_1', taskId,
    JSON.stringify({ kind: 'NEED_SCENES', scene_requirements: [], frame_ids: [frameId], reference_ids: [], comment: 'need more scenes', proposed_impact: 'TARGETED_RECHECK' }),
    'PENDING', 1, 'user', nowIso(),
  )

  // A policy rule approved by the user.
  wb.store.run(
    'insert into policy_rules(rule_id,rule_version,rule_json,evidence_json,approved_by,enabled,expires_at,created_at) values (?,?,?,?,?,?,?,?)',
    'rule_1', 1,
    JSON.stringify({
      rule_name: 'own research', actions: ['search', 'preview'], match: { platform_ids: [], adapter_ids: [], source_ids: [], license_ids: [], allowed_hosts: [], processing_destinations: [] },
      verdict: 'ALLOW', conditions: [], evidence_asset_ids: [], expires_at: null,
      basis: { text: 'user approved local research', reference_urls: [], evidence_asset_ids: [], external_basis_state: 'NOT_APPLICABLE', external_basis_note: 'internal only' },
    }),
    '{}', 'user', 1, null, nowIso(),
  )

  return {
    dir, wb, taskId, sourceId, artifactId, mediaId, frameId,
    segmentA: 'seg_a', segmentB: 'seg_b', batchId: 'batch_1', exportId: 'exp_1', feedbackId: 'fb_1',
  }
}

beforeEach(() => { fx = fixture() })
afterEach(() => { rmSync(fx.dir, { recursive: true, force: true }) })

describe('search plan and source reads', () => {
  it('getSearchPlan returns the stored plan and rejects an unknown task', () => {
    const query = {
      query_id: 'q1', platform_id: 'youtube', adapter_id: 'agent_browser', search_path: 'object',
      query_text: 'wind turbine drone', language: 'en', hypothesis: 'drone footage exists', parent_source_id: null,
      limit: 20, purpose: 'initial',
    }
    fx.wb.store.run('insert into search_queries(query_id,task_id,task_revision,query_json,plan_id,status,created_at) values (?,?,?,?,?,?,?)', 'q1', fx.taskId, 1, JSON.stringify(query), 'plan_1', 'PLANNED', nowIso())
    const first = fx.wb.getSearchPlan(fx.taskId)
    expect(first.queries).toHaveLength(1)
    expect(first.queries[0].query_id).toBe('q1')
    expect(fx.wb.getSearchPlan(fx.taskId)).toEqual(first)
    expect(codeOf(() => fx.wb.getSearchPlan('missing'))).toBe('NOT_FOUND')
  })

  it('listSourceVariants maps rows and rejects an unknown source', () => {
    fx.wb.store.run(
      'insert into source_variants(variant_id,source_id,adapter_id,state,width,height,duration_s,bytes,bitrate_bps,mime_type,locator_key,url_redacted,evidence_json,discovered_at,expires_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'var_1', fx.sourceId, 'agent_browser', 'DISCOVERED', 1920, 1080, 10, 1000, 800000, 'video/mp4', 'loc_1', 'https://example.test/redacted', JSON.stringify({ metadata_evidence_ids: ['art_evidence'] }), nowIso(), null,
    )
    const page = fx.wb.listSourceVariants(fx.sourceId)
    expect(page.variants[0]).toMatchObject({ variant_id: 'var_1', width: 1920, metadata_evidence_ids: ['art_evidence'] })
    expect(fx.wb.listSourceVariants(fx.sourceId)).toEqual(page)
    expect(codeOf(() => fx.wb.listSourceVariants('missing'))).toBe('NOT_FOUND')
  })
})

describe('verifySource and quality assessment', () => {
  it('verifies once, is idempotent, rejects bad evidence and disputed state', () => {
    const input = {
      source_id: fx.sourceId, method: 'BROWSER_CAPTURE', evidence_asset_ids: ['art_evidence'],
      observed_url: 'https://example.test/watch?v=abc', observed_platform_item_id: null, note: 'saw the page',
    }
    const ack = fx.wb.verifySource(input, 'agent')
    expect(ack.entity_type).toBe('source_verification')
    expect(fx.wb.getSource(fx.sourceId).verification_state).toBe('PAGE_VERIFIED')
    expect(fx.wb.verifySource(input, 'agent')).toEqual(ack)
    // An agent may never forge a user-supplied record.
    expect(codeOf(() => fx.wb.verifySource({ ...input, method: 'USER_SUPPLIED_RECORD' }, 'agent'))).toBe('FORBIDDEN')
    // Evidence owned by another source cannot be used to verify this one.
    const other = fx.wb.registerSource(sourceInput(fx.taskId, {
      canonical_url: 'https://example.test/other', client_discovery_id: 'disc-2',
    }), 'agent').source.source_id
    insertArtifact(fx.wb, 'art_foreign', 'artifacts/art_foreign/file.png', 'screenshot', { source_id: other })
    expect(codeOf(() => fx.wb.verifySource({ ...input, evidence_asset_ids: ['art_foreign'] }, 'agent'))).toBe('REFERENCE_NOT_FOUND')
    expect(codeOf(() => fx.wb.verifySource({ ...input, evidence_asset_ids: ['missing'] }, 'agent'))).toBe('ARTIFACT_MISSING')
    expect(codeOf(() => fx.wb.verifySource({ ...input, source_id: 'missing' }, 'agent'))).toBe('NOT_FOUND')
    fx.wb.store.run("update sources set verification_state='DISPUTED' where source_id=?", fx.sourceId)
    expect(codeOf(() => fx.wb.verifySource({ ...input, method: 'ADAPTER_METADATA' }, 'agent'))).toBe('INVALID_STATE')
  })

  it('records quality once per exact input and enforces current revision', () => {
    insertObservation(fx.wb, 'obs_1', fx.taskId, fx.frameId)
    const input = {
      task_id: fx.taskId, task_revision: 1, frame_id: fx.frameId, dimension: 'technical', state: 'UNCERTAIN',
      evidence_asset_ids: ['art_evidence'], observation_ids: ['obs_1'], reason: 'blurred',
    }
    const ack = fx.wb.recordQualityAssessment(input, 'agent')
    expect(ack.entity_type).toBe('quality_assessment')
    expect(fx.wb.recordQualityAssessment(input, 'agent')).toEqual(ack)
    expect(codeOf(() => fx.wb.recordQualityAssessment({ ...input, task_revision: 2 }, 'agent'))).toBe('INVALID_STATE')
    expect(codeOf(() => fx.wb.recordQualityAssessment({ ...input, frame_id: 'missing' }, 'agent'))).toBe('NOT_FOUND')
    expect(codeOf(() => fx.wb.recordQualityAssessment({ ...input, evidence_asset_ids: ['missing'] }, 'agent'))).toBe('ARTIFACT_MISSING')
  })
})

describe('frame and coverage reads', () => {
  it('getFrame returns effective states; missing frame is NOT_FOUND', () => {
    insertObservation(fx.wb, 'obs_1', fx.taskId, fx.frameId)
    const detail = fx.wb.getFrame(fx.frameId, fx.taskId)
    expect(detail).toMatchObject({ frame_id: fx.frameId, effective_target_state: 'PRESENT', effective_viewpoint_state: 'MATCH' })
    expect(detail.observation_ids).toContain('obs_1')
    expect(detail.quality_assessment_ids).toEqual(expect.arrayContaining(['qa_tech', 'qa_biz']))
    expect(fx.wb.getFrame(fx.frameId, fx.taskId)).toEqual(detail)
    expect(codeOf(() => fx.wb.getFrame('missing'))).toBe('NOT_FOUND')
  })

  it('listFrames pages and filters by kind', () => {
    insertObservation(fx.wb, 'obs_1', fx.taskId, fx.frameId)
    const all = fx.wb.listFrames(fx.taskId)
    expect(all.items.map((i: Dict) => i.frame_id)).toContain(fx.frameId)
    expect(all.next_cursor).toBeNull()
    const images = fx.wb.listFrames(fx.taskId, { frame_kind: 'STILL_IMAGE' })
    expect(images.items).toHaveLength(1)
    const video = fx.wb.listFrames(fx.taskId, { frame_kind: 'VIDEO_FRAME' })
    expect(video.items).toHaveLength(0)
    expect(fx.wb.listFrames(fx.taskId)).toEqual(all)
    expect(codeOf(() => fx.wb.listFrames('missing'))).toBe('NOT_FOUND')
  })

  it('listCoverage, listSegments and listOverlaps return stored jobs evidence', () => {
    const job = fx.wb.submitJob({ task_id: fx.taskId, kind: 'search.plan', client_request_id: 'cover-1', input: { feedback_ids: [] } }, 'agent')
    fx.wb.store.run(
      'insert into coverage_events(coverage_id,task_id,media_id,job_id,kind,coverage_json,created_at) values (?,?,?,?,?,?,?)',
      'cov_1', fx.taskId, fx.mediaId, job.job_id, 'SAMPLED', JSON.stringify({ ranges: [{ start_s: 0, end_s: 5 }], frame_ids: [fx.frameId], asset_ids: ['art_evidence'], seed: 42 }), nowIso(),
    )
    const coverage = fx.wb.listCoverage(fx.taskId)
    expect(coverage.items[0]).toMatchObject({ coverage_id: 'cov_1', ranges: [{ start_s: 0, end_s: 5 }], seed: 42 })
    expect(fx.wb.listCoverage(fx.taskId)).toEqual(coverage)

    const segments = fx.wb.listSegments(fx.mediaId)
    expect(segments.items.map((s: Dict) => s.segment_id)).toEqual(['seg_a', 'seg_b'])
    expect(fx.wb.listSegments(fx.mediaId)).toEqual(segments)
    expect(codeOf(() => fx.wb.listSegments('missing'))).toBe('NOT_FOUND')

    const overlaps = fx.wb.listOverlaps(fx.taskId)
    expect(overlaps.items[0]).toMatchObject({ relation_id: 'rel_1', status: 'SUGGESTED', method: 'visual' })
    expect(fx.wb.listOverlaps(fx.taskId)).toEqual(overlaps)
    expect(codeOf(() => fx.wb.listOverlaps('missing'))).toBe('NOT_FOUND')
  })
})

describe('policy reads and proposals', () => {
  const policy = (over: Dict = {}): Dict => ({
    task_id: fx.taskId, source_id: fx.sourceId, action: 'preview', proposed_basis: 'need a preview',
    evidence_asset_ids: ['art_evidence'], conditions: ['local only'],
    scope: { platform_ids: ['youtube'], adapter_ids: [], source_ids: [], license_ids: [], allowed_hosts: [], processing_destinations: [] },
    basis: { text: 'internal preview', reference_urls: [], evidence_asset_ids: [], external_basis_state: 'NOT_APPLICABLE', external_basis_note: 'internal' },
    ...over,
  })

  it('proposePolicy is idempotent, validates references and stays PENDING', () => {
    const ack = fx.wb.proposePolicy(policy(), 'agent')
    expect(ack.entity_type).toBe('policy_request')
    expect(fx.wb.proposePolicy(policy(), 'agent')).toEqual(ack)
    const listed = fx.wb.listPolicyRequests(fx.taskId)
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0].status).toBe('PENDING')
    expect(codeOf(() => fx.wb.proposePolicy(policy({ source_id: 'missing' }), 'agent'))).toBe('NOT_FOUND')
    expect(codeOf(() => fx.wb.proposePolicy(policy({ action: 'bogus' }), 'agent'))).toBe('SCHEMA_INVALID')
    expect(ack.entity_id).toMatch(/^pol_[0-9a-f]{20}$/)
    const reordered = {
      basis: { text: 'internal preview', reference_urls: [], evidence_asset_ids: [], external_basis_state: 'NOT_APPLICABLE', external_basis_note: 'internal' },
      scope: { platform_ids: ['youtube'], adapter_ids: [], source_ids: [], license_ids: [], allowed_hosts: [], processing_destinations: [] },
      conditions: ['local only'], evidence_asset_ids: ['art_evidence'], proposed_basis: 'need a preview',
      source_id: fx.sourceId, task_id: fx.taskId, action: 'preview',
    }
    expect(fx.wb.proposePolicy(reordered, 'agent')).toEqual(ack)
    expect(fx.wb.listPolicyRequests(fx.taskId).items).toHaveLength(1)
  })

  it('mutationAck refuses to invent an event id when the audit event is gone', () => {
    const input = policy()
    const requestId = `pol_${sha256Hex(canonicalJson(input as any)).slice(0, 20)}`
    fx.wb.store.run(
      'insert into policy_requests(request_id,task_id,source_id,action,proposed_basis,evidence_json,status,created_at) values (?,?,?,?,?,?,?,?)',
      requestId, input.task_id, input.source_id, input.action, input.proposed_basis, JSON.stringify(input), 'PENDING', nowIso(),
    )
    expect(codeOf(() => fx.wb.proposePolicy(input, 'agent'))).toBe('AUDIT_EVENT_MISSING')
  })

  it('listPolicyRules and getBootstrap report what the user still must set up', () => {
    const rules = fx.wb.listPolicyRules()
    expect(rules.items[0]).toMatchObject({ rule_id: 'rule_1', enabled: true })
    expect(fx.wb.listPolicyRules()).toEqual(rules)
    const before = fx.wb.getBootstrap()
    expect(before).toMatchObject({ state: 'NEEDS_USER_SETUP', reviewer_enrolled: false })
    expect(before.missing_items).toContain('reviewer_account')
    expect(fx.wb.getBootstrap()).toEqual(before)
  })
})

describe('review, export and feedback reads', () => {
  it('listReviewBatches and getReviewBatch expose counts and items', () => {
    const list = fx.wb.listReviewBatches(fx.taskId)
    expect(list.items[0]).toMatchObject({ batch_id: 'batch_1', candidate_count: 1, audit_count: 0 })
    expect(fx.wb.listReviewBatches(fx.taskId)).toEqual(list)
    const detail = fx.wb.getReviewBatch('batch_1')
    expect(detail.items[0]).toMatchObject({ frame_id: fx.frameId, item_kind: 'CANDIDATE', group_id: 'grp_1', effective_review_id: null })
    expect(detail).toMatchObject({ audit_seed: 7, blind_audit: true, audit_shortfall: 0 })
    expect(codeOf(() => fx.wb.getReviewBatch('missing'))).toBe('NOT_FOUND')
  })

  it('getExport never claims annotation or dataset readiness', () => {
    const got = fx.wb.getExport('exp_1')
    expect(got).toMatchObject({ export_id: 'exp_1', batch_id: 'batch_1', annotation_complete: false, dataset_ready: false })
    expect(got.included_frame_ids).toEqual([fx.frameId])
    expect(fx.wb.getExport('exp_1')).toEqual(got)
    expect(codeOf(() => fx.wb.getExport('missing'))).toBe('NOT_FOUND')
  })

  it('listFeedback returns feedback and affected frames', () => {
    const list = fx.wb.listFeedback(fx.taskId)
    expect(list.items[0]).toMatchObject({ feedback_id: 'fb_1', status: 'PENDING', affected_frame_ids: [fx.frameId] })
    expect(fx.wb.listFeedback(fx.taskId)).toEqual(list)
    expect(codeOf(() => fx.wb.listFeedback('missing'))).toBe('NOT_FOUND')
  })
})

describe('importEvidence', () => {
  function evidence(over: Dict = {}): Dict {
    return {
      source_id: fx.sourceId, import_relative_path: 'capture.png', kind: 'browser_capture',
      captured_at: '2026-01-01T00:00:00Z', page_url: 'https://example.test/watch?v=abc', preview_time_s: 3.5,
      capture_tool: 'playwright', ...over,
    }
  }

  it('copies a file from dataDir/inbox once and rejects escapes and missing paths', () => {
    const inbox = join(fx.dir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'capture.png'), Buffer.from('fake-png-bytes'))
    const ack = fx.wb.importEvidence(evidence(), 'agent')
    expect(ack.entity_type).toBe('artifact')
    expect(ack.event_id).toMatch(/^evt_/)
    expect(fx.wb.importEvidence(evidence(), 'agent')).toEqual(ack)
    const artifact = fx.wb.store.get<Dict>('select * from artifacts where artifact_id=?', ack.entity_id)!
    expect(artifact.kind).toBe('browser_capture')
    expect(artifact.mime_type).toBe('image/png')
    expect(JSON.parse(String(artifact.metadata_json))).toMatchObject({ source_id: fx.sourceId, preview_time_s: 3.5 })
    writeFileSync(join(fx.dir, 'workbench.sqlite'), Buffer.from('database bytes'))
    expect(codeOf(() => fx.wb.importEvidence(evidence({ import_relative_path: '../workbench.sqlite' }), 'agent'))).toBe('SCHEMA_INVALID')
    expect(codeOf(() => fx.wb.importEvidence(evidence({ import_relative_path: 'workbench.sqlite' }), 'agent'))).toBe('NOT_FOUND')
    expect(codeOf(() => fx.wb.importEvidence(evidence({ import_relative_path: '../escape.png' }), 'agent'))).toBe('SCHEMA_INVALID')
    expect(codeOf(() => fx.wb.importEvidence(evidence({ import_relative_path: 'missing.png' }), 'agent'))).toBe('NOT_FOUND')
    expect(codeOf(() => fx.wb.importEvidence(evidence({ source_id: 'missing' }), 'agent'))).toBe('NOT_FOUND')
  })

  it('rejects symlinks and files above the configured size limit', () => {
    const inbox = join(fx.dir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'capture.png'), Buffer.from('fake-png-bytes'))
    symlinkSync(join(inbox, 'capture.png'), join(inbox, 'link.png'))
    expect(codeOf(() => fx.wb.importEvidence(evidence({ import_relative_path: 'link.png' }), 'agent'))).toBe('SCHEMA_INVALID')

    const small = new Workbench({
      store: fx.wb.store,
      contracts: loadContracts(),
      mode: 'assisted',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      dataDir: fx.dir,
      evidenceMaxBytes: 4,
    })
    writeFileSync(join(inbox, 'big.bin'), Buffer.from('12345'))
    expect(codeOf(() => small.importEvidence(evidence({ import_relative_path: 'big.bin' }), 'agent'))).toBe('FILE_TOO_LARGE')
  })
})
