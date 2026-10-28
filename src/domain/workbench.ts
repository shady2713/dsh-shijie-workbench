import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Contracts } from '../contracts.ts'
import { Store, mapConstraint } from '../store.ts'
import { DomainError, canonicalJson, canonicalUrlKey, newId, nowIso, sha256Hex, type Json } from '../util.ts'
import { JobExecutor, type ArtifactDraft, type ClaimedJob } from './executor.ts'
import { analyzeVideo, extractFrame, probeMedia, removeTempDir, selectChangeFrames, selectFixedFrames, type MediaProbe, type SelectedFrame } from './media.ts'

const execFileAsync = promisify(execFile)

type Dict = Record<string, any>

interface ExecutedJob {
  result: Dict
  artifacts?: ArtifactDraft[]
  completion_scope?: 'FULL' | 'PARTIAL'
  unprocessed_inputs?: string[]
  apply?: (artifacts: ArtifactDraft[]) => void
}

function safeJson(text: unknown): Dict {
  try {
    const parsed = typeof text === 'string' ? JSON.parse(text) : text
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Dict) : {}
  } catch {
    return {}
  }
}

function probeFromStored(media: Dict): MediaProbe | null {
  const probe = safeJson(media.probe_json)
  return probe.probe_version ? (probe as unknown as MediaProbe) : null
}

function parseTimeBase(text: string): { num: number; den: number } {
  const parts = String(text).split('/').map(Number)
  const num = parts[0]
  const den = parts[1]
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return { num: 1, den: 1000 }
  return { num, den }
}

const TERMINAL_TASK = new Set(['CLOSED_COMPLETE', 'CLOSED_PARTIAL', 'CANCELLED'])
const LIVE_JOB = ['QUEUED', 'RUNNING', 'WAITING_AGENT', 'WAITING_APPROVAL']
const EXECUTABLE_JOB_KINDS = new Set(['media.acquire', 'media.probe', 'media.overview', 'media.sample'])

export interface WorkbenchOptions {
  store: Store
  contracts: Contracts
  mode: 'assisted' | 'unattended'
  ffmpegPath: string
  ffprobePath: string
  /** Root for imported evidence files. Defaults to the process working directory. */
  dataDir?: string
  /** Maximum accepted size of one imported evidence file, in bytes. Defaults to 20 MiB. */
  evidenceMaxBytes?: number
  /** True when the host vision diagnostic tool is enabled for this instance. */
  visionProbe?: boolean
}

/**
 * Agent-facing domain operations. Every method is one operation of
 * contracts/operation_catalog.yaml whose roles include `agent`.
 * Reviewer-only operations (review decisions, capture decisions, policy decisions,
 * task revisions, bootstrap approval, feedback creation) are deliberately absent.
 */
export class Workbench {
  readonly store: Store
  readonly contracts: Contracts
  readonly mode: 'assisted' | 'unattended'
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly executor: JobExecutor

  constructor(options: WorkbenchOptions) {
    this.store = options.store
    this.contracts = options.contracts
    this.mode = options.mode
    this.ffmpegPath = options.ffmpegPath
    this.ffprobePath = options.ffprobePath
    this.dataDir = options.dataDir ?? process.cwd()
    this.evidenceMaxBytes = options.evidenceMaxBytes ?? 20 * 1024 * 1024
    this.visionProbe = options.visionProbe === true
    this.executor = new JobExecutor(this.store, this.dataDir)
  }

  // ---- capabilities (getCapabilities) ----

  async capabilities(): Promise<Dict[]> {
    const checkedAt = nowIso()
    const probe = async (bin: string): Promise<{ ok: boolean; reason: string }> => {
      try {
        const { stdout } = await execFileAsync(bin, ['-version'], { timeout: 10_000, windowsHide: true })
        return { ok: true, reason: stdout.split('\n')[0]?.trim() || 'available' }
      } catch (error) {
        return { ok: false, reason: `cannot run ${bin}: ${(error as Error).message.split('\n')[0]}` }
      }
    }
    const [ffmpeg, ffprobe] = await Promise.all([probe(this.ffmpegPath), probe(this.ffprobePath)])
    const records: Dict[] = [
      cap('store', 'sqlite', 'AVAILABLE', `SQLite ${this.store.sqliteVersion}, journal=${this.store.journalMode}`, checkedAt),
      cap('ffmpeg', 'decode', ffmpeg.ok ? 'AVAILABLE' : 'UNCONFIGURED', ffmpeg.reason, checkedAt),
      cap('ffprobe', 'probe', ffprobe.ok ? 'AVAILABLE' : 'UNCONFIGURED', ffprobe.reason, checkedAt),
      cap('job_executor', 'run_jobs', 'AVAILABLE', 'M2 local executor: SQLite queue with claim leases, claim_generation, heartbeat and transactional completion; media jobs run in-process', checkedAt),
      cap('reviewer_surface', 'review', 'UNSUPPORTED', 'no reviewer UI in this plugin; review decisions cannot be recorded by agent tools', null),
      this.visionProbe
        ? cap('host_vision', 'view_asset', 'AVAILABLE', 'E1 verified: image probes at 512x384 and 2048x1536 were seen by the model without downscaling', checkedAt)
        : cap('host_vision', 'view_asset', 'UNCONFIGURED', 'visionProbe is disabled; the E1 diagnostic tool is not registered', null),
    ]
    for (const r of records) this.recordCapability(r)
    return records
  }

  private recordCapability(r: Dict): void {
    const last = this.store.get<{ status: string; evidence_json: string }>(
      'select status, evidence_json from capability_checks where adapter_id=? and operation=? order by checked_at desc, rowid desc limit 1',
      r.adapter_id,
      r.operation,
    )
    const evidence = JSON.stringify({ reason: r.reason })
    if (last && last.status === r.state && last.evidence_json === evidence) return
    this.store.run(
      'insert into capability_checks(check_id, adapter_id, operation, implementation_version, status, evidence_json, checked_at) values (?,?,?,?,?,?,?)',
      newId('cap'),
      r.adapter_id,
      r.operation,
      'dsh-shijie-workbench/0.1.0',
      r.state,
      evidence,
      r.checked_at ?? nowIso(),
    )
  }

  // ---- tasks ----

  createTask(raw: unknown, actor: string): Dict {
    const asObj = (raw ?? {}) as Dict
    if (asObj.stage === 'active' && !targetDefined(asObj.target)) {
      throw new DomainError('TARGET_NOT_DEFINED', 'an active task needs a target name and definition', {
        status: 'BLOCKED',
        blockers: [{ code: 'TARGET_NOT_DEFINED', entity_id: 'new', missing: 'target.name and target.definition', retryable: false }],
      })
    }
    const spec = this.contracts.assert<Dict>('TaskSpec', raw)
    const sampling = spec.sampling as Dict | undefined
    if (spec.schema_version === '1.3' && sampling) {
      const min = sampling.min_frame_interval_s
      const max = sampling.max_frame_interval_s
      if (typeof min === 'number' && typeof max === 'number' && max < min) {
        throw new DomainError('SCHEMA_INVALID', 'max_frame_interval_s must be greater than or equal to min_frame_interval_s', {
          fieldErrors: [{ field: 'sampling.max_frame_interval_s', message: 'must be >= sampling.min_frame_interval_s' }],
        })
      }
    }
    const taskId = newId('task')
    const now = nowIso()
    const status = spec.stage === 'active' ? 'READY' : 'DRAFT'
    this.store.tx(() => {
      this.store.run(
        'insert into tasks(task_id,name,current_revision,case_set_version,status,created_at,updated_at) values (?,?,?,?,?,?,?)',
        taskId, spec.task_name, 1, 1, status, now, now,
      )
      this.store.run(
        'insert into task_revisions(task_id,revision,spec_json,spec_sha256,created_at) values (?,?,?,?,?)',
        taskId, 1, JSON.stringify(spec), sha256Hex(canonicalJson(spec)), now,
      )
      this.store.audit(actor, 'task.created', 'task', taskId, { status, revision: 1 })
    })
    return this.getTask(taskId)
  }

  listTasks(): Dict[] {
    return this.store.all<{ task_id: string }>('select task_id from tasks order by created_at, task_id').map((r) => this.summary(r.task_id))
  }

  getTask(taskId: string): Dict {
    const row = this.requireTask(taskId)
    const rev = this.store.get<{ spec_json: string }>(
      'select spec_json from task_revisions where task_id=? and revision=?', taskId, Number(row.current_revision),
    )!
    const spec = JSON.parse(rev.spec_json) as Dict
    const summary = this.summary(taskId)
    const limit = Number(spec.limits?.max_sources ?? 0)
    const used = Number(summary.counts.sources)
    const blockers = this.blockers(row, spec)
    return {
      summary,
      spec,
      budgets: [{ resource_key: 'source_count', limit_units: limit, reserved_units: 0, settled_units: used, remaining_units: Math.max(0, limit - used) }],
      blockers,
      pending_feedback_ids: this.store
        .all<{ feedback_id: string }>("select feedback_id from task_feedback where task_id=? and status<>'APPLIED' order by created_at", taskId)
        .map((r) => r.feedback_id),
      open_batch_ids: this.store
        .all<{ batch_id: string }>("select batch_id from review_batches where task_id=? and status='OPEN' order by created_at", taskId)
        .map((r) => r.batch_id),
    }
  }

  resumeTask(taskId: string, actor: string): Dict {
    const row = this.requireTask(taskId)
    const status = String(row.status)
    if (status === 'DRAFT') {
      throw new DomainError('TARGET_NOT_DEFINED', 'a draft task cannot run; a reviewer must revise it to an active task first', { status: 'BLOCKED' })
    }
    if (TERMINAL_TASK.has(status)) throw new DomainError('INVALID_STATE', `task is ${status}`)
    if (!['BLOCKED', 'WAITING_AGENT', 'WAITING_APPROVAL'].includes(status)) return this.getTask(taskId)
    this.store.tx(() => {
      this.store.run("update tasks set status='READY', updated_at=? where task_id=?", nowIso(), taskId)
      this.store.audit(actor, 'task.resumed', 'task', taskId, { from: status })
    })
    return this.getTask(taskId)
  }

  /**
   * Explicit close. It never marks an empty or unfinished task complete:
   * COMPLETE needs at least one export, and live jobs, open batches or unresolved feedback block closing.
   */
  closeTask(taskId: string, actor: string): Dict {
    const row = this.requireTask(taskId)
    if (TERMINAL_TASK.has(String(row.status))) return this.getTask(taskId)
    const blockers: { code: string; entity_id: string; missing: string; retryable: boolean }[] = []
    for (const j of this.store.all<{ job_id: string }>(
      `select job_id from jobs where task_id=? and status in (${LIVE_JOB.map(() => '?').join(',')})`, taskId, ...LIVE_JOB,
    )) blockers.push({ code: 'JOB_NOT_FINISHED', entity_id: j.job_id, missing: 'finish or cancel the job', retryable: true })
    for (const b of this.store.all<{ batch_id: string }>("select batch_id from review_batches where task_id=? and status='OPEN'", taskId)) {
      blockers.push({ code: 'REVIEW_PENDING', entity_id: b.batch_id, missing: 'user review of the open batch', retryable: true })
    }
    for (const f of this.store.all<{ feedback_id: string }>("select feedback_id from task_feedback where task_id=? and status<>'APPLIED'", taskId)) {
      blockers.push({ code: 'FEEDBACK_UNRESOLVED', entity_id: f.feedback_id, missing: 'apply or resolve the feedback', retryable: true })
    }
    if (blockers.length) throw new DomainError('CLOSE_BLOCKED', 'task has unfinished work', { status: 'BLOCKED', blockers })
    const exported = this.store.get<{ c: number }>('select count(*) as c from exports where task_id=?', taskId)!.c
    const target = exported > 0 ? 'CLOSED_COMPLETE' : 'CLOSED_PARTIAL'
    this.store.tx(() => {
      this.store.run('update tasks set status=?, updated_at=? where task_id=?', target, nowIso(), taskId)
      this.store.audit(actor, 'task.closed', 'task', taskId, { status: target, exports: exported })
    })
    return this.getTask(taskId)
  }

  /** Read-only. Picks runnable work first and reports what the M1.5 slice cannot do instead of pretending. */
  nextAction(taskId: string): Dict {
    const row = this.requireTask(taskId)
    const detail = this.getTask(taskId)
    const status = String(row.status)
    const live = this.store.all<{ job_id: string; status: string; kind: string }>(
      `select job_id, status, kind from jobs where task_id=? and status in (${LIVE_JOB.map(() => '?').join(',')}) order by created_at`,
      taskId, ...LIVE_JOB,
    )
    const base = {
      job_template: null as Dict | null,
      request_id: null,
      blocking_ids: [] as string[],
      budget_remaining: detail.budgets,
      runnable_count: 0,
      waiting_branches: detail.blockers,
      state_revision: Number(this.store.get<{ c: number }>('select count(*) as c from audit_events')!.c),
    }
    const done = (action: string, reasonCode: string, patch: Dict = {}): Dict =>
      this.contracts.assert<Dict>('NextAction', { action, reason_code: reasonCode, ...base, ...patch })

    if (TERMINAL_TASK.has(status)) return done('REPORT_BLOCKED', 'TASK_CLOSED')
    if (status === 'DRAFT') {
      return done('REPORT_BLOCKED', 'TARGET_NOT_DEFINED', { blocking_ids: [taskId] })
    }
    if (detail.open_batch_ids.length) return done('WAIT_USER_REVIEW', 'REVIEW_PENDING', { blocking_ids: detail.open_batch_ids })
    const queued = live.filter((j) => j.status === 'QUEUED')
    const runnable = queued.filter((j) => EXECUTABLE_JOB_KINDS.has(String(j.kind)))
    if (runnable.length) return done('CONTINUE_WORKER', 'JOB_RUNNABLE', { blocking_ids: runnable.map((j) => j.job_id), runnable_count: runnable.length })
    if (queued.length) return done('REPORT_BLOCKED', 'CAPABILITY_MISSING', { blocking_ids: queued.map((j) => j.job_id) })
    if (live.length) return done('WAIT_JOB', 'JOB_RUNNING', { blocking_ids: live.map((j) => j.job_id) })
    const anyJob = this.store.get('select 1 as x from jobs where task_id=?', taskId)
    if (!anyJob) {
      const template = this.contracts.assert<Dict>('JobRequest', {
        task_id: taskId,
        kind: 'search.plan',
        client_request_id: `plan-r${Number(row.current_revision)}`,
        input: { feedback_ids: [] },
      })
      return done('SUBMIT_JOB', 'NO_PLAN_YET', { job_template: template, runnable_count: 1 })
    }
    const exported = Number(this.store.get<{ c: number }>('select count(*) as c from exports where task_id=?', taskId)!.c)
    if (exported > 0) return done('CLOSE_TASK', 'EXPORT_DONE')
    return done('REPORT_BLOCKED', 'NO_RUNNABLE_WORK')
  }

  private summary(taskId: string): Dict {
    const row = this.requireTask(taskId)
    const one = (sql: string): number => Number(this.store.get<{ c: number }>(sql, taskId)!.c)
    return {
      task_id: taskId,
      task_name: row.name,
      revision: Number(row.current_revision),
      case_set_version: Number(row.case_set_version),
      status: row.status,
      counts: {
        sources: one('select count(*) as c from task_sources where task_id=?'),
        verified_media: one(
          "select count(distinct m.media_id) as c from media m join media_origins o on o.media_id=m.media_id join task_sources ts on ts.source_id=o.source_id where ts.task_id=? and m.state='VERIFIED'",
        ),
        candidate_frames: one('select count(distinct frame_id) as c from observations where task_id=? and frame_id is not null'),
        accepted_frames: one(
          "select count(*) as c from review_decisions d join review_batches b on b.batch_id=d.batch_id where b.task_id=? and d.decision='ACCEPT' and d.revision=(select max(d2.revision) from review_decisions d2 where d2.batch_id=d.batch_id and d2.frame_id=d.frame_id)",
        ),
        pending_review_frames: one(
          "select count(*) as c from review_items i join review_batches b on b.batch_id=i.batch_id where b.task_id=? and b.status='OPEN' and not exists (select 1 from review_decisions d where d.batch_id=i.batch_id and d.frame_id=i.frame_id and d.revision=i.revision)",
        ),
      },
      updated_at: row.updated_at,
    }
  }

  private blockers(row: Dict, spec: Dict): Dict[] {
    const out: Dict[] = []
    const taskId = String(row.task_id)
    if (row.status === 'DRAFT') {
      out.push({
        code: targetDefined(spec.target) ? 'TASK_DRAFT' : 'TARGET_NOT_DEFINED',
        entity_id: taskId,
        missing: 'a reviewer must supply the target and revise the task to active',
        retryable: false,
      })
    }
    const queued = this.store.all<{ job_id: string; kind: string }>("select job_id, kind from jobs where task_id=? and status='QUEUED' order by created_at", taskId)
    for (const j of queued) {
      if (EXECUTABLE_JOB_KINDS.has(String(j.kind))) continue
      out.push({ code: 'CAPABILITY_MISSING', entity_id: j.job_id, missing: `no M2 handler for job kind ${j.kind}`, retryable: false })
    }
    return out
  }

  private requireTask(taskId: string): Dict {
    const row = this.store.get<Dict>('select * from tasks where task_id=?', taskId)
    if (!row) throw new DomainError('NOT_FOUND', `task not found: ${taskId}`)
    return row
  }

  // ---- sources ----

  registerSource(raw: unknown, actor: string): { source: Dict; created: boolean; discovery_id: string } {
    const input = this.contracts.assert<Dict>('SourceCreate', raw)
    const task = this.requireTask(input.task_id)
    if (TERMINAL_TASK.has(String(task.status))) throw new DomainError('INVALID_STATE', `task is ${task.status}`)
    if (task.status === 'DRAFT') throw new DomainError('TARGET_NOT_DEFINED', 'a draft task cannot collect sources', { status: 'BLOCKED' })

    const evidenceIds: string[] = input.evidence_asset_ids
    for (const id of evidenceIds) {
      if (!this.store.get('select 1 as x from artifacts where artifact_id=?', id)) {
        throw new DomainError('ARTIFACT_MISSING', `evidence asset does not exist: ${id}`)
      }
    }

    const canonicalKey = input.platform_item_id ? `id:${input.platform_item_id}` : `url:${canonicalUrlKey(input.canonical_url)}`
    const key = `${input.client_discovery_id}`

    return this.store.tx(() => {
      const prior = this.store.get<{ discovery_id: string; source_id: string }>(
        'select discovery_id, source_id from source_discoveries where task_id=? and client_discovery_id=?', input.task_id, key,
      )
      if (prior) return { source: this.sourceDetail(prior.source_id), created: false, discovery_id: prior.discovery_id }

      const now = nowIso()
      let src = this.store.get<Dict>('select * from sources where platform_id=? and canonical_key=?', input.platform_id, canonicalKey)
      let created = false
      if (src) {
        if (src.media_kind !== input.media_kind) {
          throw new DomainError('SCHEMA_INVALID', `source already registered as ${src.media_kind}; media_kind cannot change`)
        }
      } else {
        const inTask = Number(this.store.get<{ c: number }>('select count(*) as c from task_sources where task_id=?', input.task_id)!.c)
        const spec = JSON.parse(
          this.store.get<{ spec_json: string }>('select spec_json from task_revisions where task_id=? and revision=?', input.task_id, Number(task.current_revision))!.spec_json,
        ) as Dict
        if (inTask >= Number(spec.limits.max_sources)) {
          throw new DomainError('BUDGET_EXCEEDED', `task already holds ${inTask} sources (limit ${spec.limits.max_sources})`, { status: 'BLOCKED' })
        }
        const sourceId = newId('src')
        try {
          this.store.run(
            `insert into sources(source_id,platform_id,canonical_key,canonical_url,platform_item_id,media_kind,title,uploader_json,metadata_json,created_at,updated_at)
             values (?,?,?,?,?,?,?,?,?,?,?)`,
            sourceId, input.platform_id, canonicalKey, input.canonical_url, input.platform_item_id, input.media_kind,
            input.title, JSON.stringify({ name: input.uploader_name }), JSON.stringify({ discovered_via: input.discovered_via }), now, now,
          )
        } catch (error) {
          mapConstraint(error)
        }
        src = this.store.get<Dict>('select * from sources where source_id=?', sourceId)!
        created = true
        this.store.audit(actor, 'source.created', 'source', sourceId, { platform_id: input.platform_id, media_kind: input.media_kind })
      }

      const sourceId = String(src.source_id)
      const discoveryId = newId('disc')
      try {
        this.store.run(
          `insert into source_discoveries(discovery_id,task_id,source_id,search_run_id,query_id,adapter_id,platform_id,client_discovery_id,evidence_json,created_at)
           values (?,?,?,?,?,?,?,?,?,?)`,
          discoveryId, input.task_id, sourceId, input.search_run_id, input.query_id, input.adapter_id, input.platform_id, key,
          JSON.stringify({
            discovered_via: input.discovered_via, query_text: input.query_text, observed_at: input.observed_at,
            evidence_asset_ids: evidenceIds, canonical_url: input.canonical_url,
          }), now,
        )
      } catch (error) {
        mapConstraint(error)
      }
      this.store.run(
        'insert or ignore into task_sources(task_id,source_id,first_discovery_id) values (?,?,?)', input.task_id, sourceId, discoveryId,
      )
      this.store.audit(actor, 'source.discovered', 'source', sourceId, { task_id: input.task_id, discovery_id: discoveryId })
      return { source: this.sourceDetail(sourceId), created, discovery_id: discoveryId }
    })
  }

  getSource(sourceId: string): Dict {
    return this.sourceDetail(sourceId)
  }

  listSources(taskId: string): Dict[] {
    this.requireTask(taskId)
    return this.store
      .all<{ source_id: string }>('select source_id from task_sources where task_id=? order by source_id', taskId)
      .map((r) => this.sourceDetail(r.source_id))
  }

  private sourceDetail(sourceId: string): Dict {
    const s = this.store.get<Dict>('select * from sources where source_id=?', sourceId)
    if (!s) throw new DomainError('NOT_FOUND', `source not found: ${sourceId}`)
    const ids = (sql: string): string[] => this.store.all<{ id: string }>(sql, sourceId).map((r) => r.id)
    return {
      source_id: s.source_id,
      platform_id: s.platform_id,
      canonical_key: s.canonical_key,
      canonical_url: s.canonical_url,
      verification_state: s.verification_state,
      route_state: s.route_state,
      capture_evidence_state: s.capture_evidence_state,
      variant_ids: ids('select variant_id as id from source_variants where source_id=? order by variant_id'),
      media_ids: ids('select media_id as id from media_origins where source_id=? order by media_id'),
      discovery_ids: ids('select discovery_id as id from source_discoveries where source_id=? order by created_at'),
      assessment_ids: ids('select assessment_id as id from capture_assessments where source_id=? order by created_at'),
      media_kind: s.media_kind,
    }
  }

  // ---- capture assessment proposals (proposeCaptureAssessment) ----

  proposeCapture(raw: unknown, actor: string): Dict {
    const input = this.contracts.assert<Dict>('CaptureAssessmentCreate', raw)
    if (!this.store.get('select 1 as x from sources where source_id=?', input.source_id)) {
      throw new DomainError('NOT_FOUND', `source not found: ${input.source_id}`)
    }
    if (input.media_id) {
      const link = this.store.get(
        'select 1 as x from media_origins where media_id=? and source_id=?', input.media_id, input.source_id,
      )
      if (!link) throw new DomainError('REFERENCE_NOT_FOUND', 'media does not belong to this source')
    }
    for (const id of input.evidence_asset_ids as string[]) {
      if (!this.store.get('select 1 as x from artifacts where artifact_id=?', id)) {
        throw new DomainError('ARTIFACT_MISSING', `evidence asset does not exist: ${id}`)
      }
    }
    if (input.basis_kind === 'VISUAL_ONLY' && input.proposed_state === 'SUPPORTED') {
      throw new DomainError('SCHEMA_INVALID', 'a visual-only impression cannot propose SUPPORTED capture evidence', {
        fieldErrors: [{ field: '/proposed_state', message: 'VISUAL_ONLY cannot be SUPPORTED' }],
      })
    }
    const id = newId('capa')
    return this.store.tx(() => {
      try {
        this.store.run(
          `insert into capture_assessments(assessment_id,source_id,media_id,proposed_state,basis_kind,content_kind,proposal_json,actor_id,created_at)
           values (?,?,?,?,?,?,?,?,?)`,
          id, input.source_id, input.media_id, input.proposed_state, input.basis_kind, input.content_kind, JSON.stringify(input), actor, nowIso(),
        )
      } catch (error) {
        mapConstraint(error)
      }
      const eventId = this.store.audit(actor, 'capture.proposed', 'capture_assessment', id, { source_id: input.source_id, proposed_state: input.proposed_state })
      return { entity_type: 'capture_assessment', entity_id: id, revision: null, event_id: eventId }
    })
  }

  // ---- jobs ----

  submitJob(raw: unknown, actor: string): Dict {
    const req = this.contracts.assert<Dict>('JobRequest', raw)
    const task = this.requireTask(req.task_id)
    if (TERMINAL_TASK.has(String(task.status))) throw new DomainError('INVALID_STATE', `task is ${task.status}`)
    if (task.status === 'DRAFT') throw new DomainError('TARGET_NOT_DEFINED', 'a draft task cannot run jobs', { status: 'BLOCKED' })

    const idempotencyKey = `${req.task_id}:${req.client_request_id}`
    const requestJson = canonicalJson(req as Json)
    return this.store.tx(() => {
      const prior = this.store.get<Dict>('select * from jobs where idempotency_key=?', idempotencyKey)
      if (prior) {
        if (canonicalJson(JSON.parse(String(prior.request_json))) !== requestJson) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'client_request_id was already used with a different request')
        }
        return this.jobSummary(String(prior.job_id))
      }
      const jobId = newId('job')
      const now = nowIso()
      const specRow = this.store.get<{ spec_json: string }>(
        'select spec_json from task_revisions where task_id=? and revision=?', req.task_id, Number(task.current_revision),
      )
      const maxAttempts = Math.max(1, Math.min(5, Number(specRow ? (JSON.parse(specRow.spec_json) as Dict).limits?.max_attempts : 3)))
      try {
        this.store.run(
          `insert into jobs(job_id,task_id,task_revision,kind,idempotency_key,request_json,status,attempt,max_attempts,created_at,updated_at)
           values (?,?,?,?,?,?, 'QUEUED', 0, ?, ?, ?)`,
          jobId, req.task_id, Number(task.current_revision), req.kind, idempotencyKey, requestJson, maxAttempts, now, now,
        )
      } catch (error) {
        mapConstraint(error)
      }
      this.store.audit(actor, 'job.submitted', 'job', jobId, { kind: req.kind })
      return this.jobSummary(jobId)
    })
  }

  getJob(jobId: string): Dict {
    return this.jobSummary(jobId)
  }

  listJobs(taskId?: string): Dict[] {
    const rows = taskId
      ? this.store.all<{ job_id: string }>('select job_id from jobs where task_id=? order by created_at, job_id', taskId)
      : this.store.all<{ job_id: string }>('select job_id from jobs order by created_at, job_id')
    return rows.map((r) => this.jobSummary(r.job_id))
  }

  cancelJob(jobId: string, actor: string): Dict {
    const job = this.store.get<Dict>('select * from jobs where job_id=?', jobId)
    if (!job) throw new DomainError('NOT_FOUND', `job not found: ${jobId}`)
    if (!LIVE_JOB.includes(String(job.status))) {
      if (job.status === 'CANCELLED') return this.jobSummary(jobId)
      throw new DomainError('INVALID_STATE', `job is ${job.status} and cannot be cancelled`)
    }
    this.store.tx(() => {
      this.store.run("update jobs set status='CANCELLED', worker_id=null, lease_token_sha256=null, lease_expires_at=null, updated_at=? where job_id=?", nowIso(), jobId)
      this.store.audit(actor, 'job.cancelled', 'job', jobId, { from: job.status })
    })
    return this.jobSummary(jobId)
  }

  private jobSummary(jobId: string): Dict {
    const j = this.store.get<Dict>('select * from jobs where job_id=?', jobId)
    if (!j) throw new DomainError('NOT_FOUND', `job not found: ${jobId}`)
    return {
      job_id: j.job_id,
      task_id: j.task_id,
      task_revision: j.task_revision,
      kind: j.kind,
      status: j.status,
      attempt: Number(j.attempt),
      completion_scope: j.completion_scope,
      artifact_ids: this.store.all<{ id: string }>('select artifact_id as id from artifacts where job_id=? order by artifact_id', jobId).map((r) => r.id),
      unprocessed_inputs: JSON.parse(String(j.unprocessed_inputs_json)),
      error_code: j.error_code,
      updated_at: j.updated_at,
    }
  }

  // ---- M2 local job executor ----

  /** Run a bounded number of local media jobs. This is the one write entry that processes the queue. */
  async runJobs(maxJobs = 1): Promise<Dict[]> {
    const limit = Math.max(1, Math.min(10, Math.floor(Number(maxJobs) || 1)))
    const out: Dict[] = []
    for (let i = 0; i < limit; i += 1) {
      const claim = this.executor.claimNext('local-executor', 60_000, [...EXECUTABLE_JOB_KINDS])
      if (!claim) break
      try {
        const executed = await this.executeJob(claim)
        const completion = this.executor.complete(claim, {
          result: executed.result,
          artifacts: executed.artifacts ?? [],
          completion_scope: executed.completion_scope ?? 'FULL',
          unprocessed_inputs: executed.unprocessed_inputs ?? [],
          apply: executed.apply,
        })
        out.push({
          job_id: claim.job_id,
          kind: claim.kind,
          status: 'SUCCEEDED',
          attempt: claim.attempt,
          already_completed: completion.already_completed,
          artifact_ids: completion.artifact_ids,
          result: executed.result,
        })
      } catch (error) {
        const failure = this.executor.fail(claim, error)
        out.push({
          job_id: claim.job_id,
          kind: claim.kind,
          status: failure.status,
          attempt: claim.attempt,
          error_code: failure.error_code,
          retryable: failure.retryable,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        removeTempDir(join(this.dataDir, 'tmp', claim.job_id))
      }
    }
    return out
  }

  private async executeJob(claim: ClaimedJob): Promise<ExecutedJob> {
    switch (claim.kind) {
      case 'media.acquire': return this.executeMediaAcquire(claim)
      case 'media.probe': return this.executeMediaProbe(claim)
      case 'media.overview': return this.executeMediaOverview(claim)
      case 'media.sample': return this.executeMediaSample(claim)
      default:
        throw new DomainError('CAPABILITY_MISSING', `job kind ${claim.kind} is not implemented in the M2 executor`, { retryable: false })
    }
  }

  private taskSpecFor(claim: ClaimedJob): { taskId: string; spec: Dict } {
    if (!claim.task_id || claim.task_revision === null) {
      throw new DomainError('INVALID_STATE', 'media jobs require a task revision', { retryable: false })
    }
    const row = this.store.get<{ spec_json: string }>(
      'select spec_json from task_revisions where task_id=? and revision=?', claim.task_id, claim.task_revision,
    )
    if (!row) throw new DomainError('REFERENCE_NOT_FOUND', `task revision ${claim.task_id}@${claim.task_revision} does not exist`)
    return { taskId: claim.task_id, spec: JSON.parse(row.spec_json) as Dict }
  }

  private executeMediaAcquire(claim: ClaimedJob): ExecutedJob {
    const { taskId, spec } = this.taskSpecFor(claim)
    const input = (claim.request.input ?? {}) as Dict
    if (input.strategy !== 'official_file') {
      throw new DomainError('CAPABILITY_MISSING', `M2 only acquires local official_file material; strategy ${String(input.strategy)} belongs to M4`, { retryable: false })
    }
    const source = this.store.get<Dict>('select * from sources where source_id=?', input.source_id)
    if (!source) throw new DomainError('NOT_FOUND', `source not found: ${input.source_id}`)
    if (!this.store.get('select 1 as x from task_sources where task_id=? and source_id=?', taskId, input.source_id)) {
      throw new DomainError('REFERENCE_NOT_FOUND', 'source is not part of this task')
    }
    const variant = this.store.get<Dict>('select * from source_variants where variant_id=? and source_id=?', input.variant_id, input.source_id)
    if (!variant) throw new DomainError('NOT_FOUND', `source variant not found: ${input.variant_id}`)
    if (String(source.media_kind) !== 'VIDEO') {
      throw new DomainError('CAPABILITY_MISSING', 'M2 media acquisition handles video only; image normalization is M2b', { retryable: false })
    }

    const filePath = this.resolveLocalMediaFile(String(variant.locator_key))
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new DomainError('SCHEMA_INVALID', 'local media must be a regular file, not a symlink or directory')
    const maxBytes = Math.min(Number(input.max_bytes), Number(spec.limits.max_file_bytes))
    if (stat.size > maxBytes) throw new DomainError('BUDGET_EXCEEDED', `file is ${stat.size} bytes; limit is ${maxBytes}`)
    const bytes = readFileSync(filePath)
    const digest = sha256Hex(bytes)
    const mediaId = `med_${sha256Hex(`${input.source_id}:${digest}`).slice(0, 20)}`
    const artifactId = `art_${sha256Hex(`${input.source_id}:${digest}:media`).slice(0, 20)}`
    const relPath = `artifacts/${artifactId}/source${extname(filePath).toLowerCase() || '.bin'}`
    const absoluteArtifact = join(this.dataDir, relPath)
    mkdirSync(join(this.dataDir, 'artifacts', artifactId), { recursive: true })
    copyFileSync(filePath, absoluteArtifact)
    const sourceMetadata = safeJson(source.metadata_json)
    const synthetic = sourceMetadata.synthetic === true
    const artifact: ArtifactDraft = {
      artifact_id: artifactId,
      kind: 'media',
      relative_path: relPath,
      sha256: digest,
      bytes: bytes.length,
      mime_type: mimeFor(filePath),
      metadata: { source_id: input.source_id, variant_id: input.variant_id, local_official_file: true, original_name: basename(filePath) },
      synthetic,
    }
    return {
      result: {
        media_id: mediaId,
        source_id: input.source_id,
        variant_id: input.variant_id,
        media_kind: 'VIDEO',
        state: 'ACQUIRED',
        sha256: digest,
        bytes: bytes.length,
        origin_linked: false,
        note: 'M2 local official_file acquisition; media_origins policy link is deferred to the M4 channel adapter',
      },
      artifacts: [artifact],
      apply: (artifacts) => {
        const a = artifacts.find((x) => x.artifact_id === artifactId)
        if (!a) throw new DomainError('INTERNAL', 'media artifact was not registered')
        this.store.run(
          `insert or ignore into media(media_id,artifact_id,media_kind,sha256,state,width,height,duration_s,probe_json,decode_scope_json,created_at)
           values (?,?,?,?, 'ACQUIRED', NULL, NULL, NULL, '{}', '{}', ?)`,
          mediaId, a.artifact_id, 'VIDEO', digest, nowIso(),
        )
      },
    }
  }

  private async executeMediaProbe(claim: ClaimedJob): Promise<ExecutedJob> {
    const input = (claim.request.input ?? {}) as Dict
    const media = this.requireMediaWithArtifact(String(input.media_id))
    const absolute = this.mediaAbsolutePath(media)
    const probe = await probeMedia(this.ffprobePath, absolute)
    return {
      result: {
        media_id: media.media_id,
        state: 'VERIFIED',
        format_name: probe.format_name,
        duration_s: probe.duration_s,
        start_time_s: probe.start_time_s,
        nonzero_start: probe.nonzero_start,
        video_streams: probe.video_streams,
        cfr: probe.cfr,
        vfr: probe.vfr,
        pts_monotonic: probe.pts_monotonic,
        pts_regular: probe.pts_regular,
        sampled_frame_count: probe.sampled_frame_count,
        validate_ranges: input.validate_ranges ?? [],
      },
      apply: () => {
        this.store.run(
          `update media set state='VERIFIED', width=?, height=?, duration_s=?, probe_json=?, decode_scope_json=? where media_id=?`,
          probe.primary.width, probe.primary.height, probe.duration_s, JSON.stringify(probe), JSON.stringify({ validated_ranges: input.validate_ranges ?? [] }), String(media.media_id),
        )
      },
    }
  }

  private async executeMediaOverview(claim: ClaimedJob): Promise<ExecutedJob> {
    const { taskId, spec } = this.taskSpecFor(claim)
    const input = (claim.request.input ?? {}) as Dict
    const media = this.requireMediaWithArtifact(String(input.media_id))
    const absolute = this.mediaAbsolutePath(media)
    let probe = probeFromStored(media)
    let refreshProbe = false
    if (!probe) {
      probe = await probeMedia(this.ffprobePath, absolute)
      refreshProbe = true
    }
    if (probe.duration_s <= 0) throw new DomainError('MEDIA_PROBE_FAILED', 'video duration is zero or unknown')

    const startS = Math.max(0, Number(input.start_s ?? 0))
    const endS = Math.min(probe.duration_s, Number(input.end_s ?? probe.duration_s))
    if (!(endS > startS)) throw new DomainError('SCHEMA_INVALID', 'end_s must be greater than start_s')
    const tempDir = join(this.dataDir, 'tmp', claim.job_id)
    const analysis = await analyzeVideo(this.ffmpegPath, absolute, tempDir, probe.start_time_s)
    const rangeFrames = analysis.frames.filter((f) => f.time_s >= startS - 0.0001 && f.time_s <= endS + 0.0001)
    if (rangeFrames.length === 0) throw new DomainError('MEDIA_DECODE_FAILED', 'no decoded frames in the requested range')
    const rangeAnalysis = {
      ...analysis,
      frames: rangeFrames,
      scene_cuts: analysis.scene_cuts.filter((c) => c.time_s >= startS - 0.0001 && c.time_s <= endS + 0.0001),
      duration_s: endS - startS,
    }
    const sampling = (spec.sampling ?? {}) as Dict
    const adaptive = typeof sampling.change_threshold === 'number' && typeof sampling.max_frame_interval_s === 'number'
    const maxFrames = Math.max(1, Math.min(Number(spec.limits.max_candidate_frames), 500))
    const selection = adaptive
      ? selectChangeFrames(rangeAnalysis, {
          change_threshold: Number(sampling.change_threshold),
          min_frame_interval_s: Number(sampling.min_frame_interval_s ?? 0.5),
          max_frame_interval_s: Number(sampling.max_frame_interval_s ?? 10),
          scene_cut_threshold: Number(sampling.scene_cut_threshold ?? 0.3),
          max_candidate_frames: maxFrames,
        })
      : selectFixedFrames(rangeAnalysis, Number(input.interval_s ?? sampling.overview_interval_s ?? 5), maxFrames)

    const timeBase = parseTimeBase(probe.primary.time_base)
    const transformJson = canonicalJson({ type: 'identity', width: probe.primary.width, height: probe.primary.height })
    const transformSha = sha256Hex(transformJson)
    const artifacts: ArtifactDraft[] = []
    const frameRows: Dict[] = []
    const frameIds: string[] = []
    for (const selected of selection.selected) {
      const pts = Math.max(0, Math.round((selected.time_s - probe.start_time_s) / (timeBase.num / timeBase.den)))
      const identity = sha256Hex(`${String(media.media_id)}:${probe.primary.index}:${pts}:${transformSha}`)
      const frameId = `frm_${identity.slice(0, 20)}`
      frameIds.push(frameId)
      const existing = this.store.get<{ artifact_id: string }>('select artifact_id from frames where frame_identity_sha256=?', identity)
      if (existing) {
        frameRows.push({ existing: true, frame_id: frameId, artifact_id: existing.artifact_id, time_s: selected.time_s, trigger: selected.trigger })
        continue
      }
      const artifactId = `art_${sha256Hex(`${identity}:frame`).slice(0, 20)}`
      const relPath = `artifacts/${artifactId}/frame.png`
      const absoluteArtifact = join(this.dataDir, relPath)
      mkdirSync(join(this.dataDir, 'artifacts', artifactId), { recursive: true })
      await extractFrame(this.ffmpegPath, absolute, selected.time_s, absoluteArtifact)
      const bytes = readFileSync(absoluteArtifact)
      const pixelSha = sha256Hex(bytes)
      const quality = {
        selection_version: 'm2-change-v1',
        analysis_fps: 5,
        change_score: selected.change_score,
        scene_cut_score: selected.scene_cut_score,
        trigger: selected.trigger,
        blur_variance: selected.blur_variance,
        similarity_group_id: null,
      }
      artifacts.push({
        artifact_id: artifactId,
        kind: 'frame',
        relative_path: relPath,
        sha256: pixelSha,
        bytes: bytes.length,
        mime_type: 'image/png',
        metadata: { media_id: media.media_id, frame_id: frameId, time_s: selected.time_s, trigger: selected.trigger },
        synthetic: Boolean(safeJson(media.metadata_json).synthetic),
      })
      frameRows.push({
        existing: false,
        frame_id: frameId,
        artifact_id: artifactId,
        media_id: media.media_id,
        frame_kind: 'VIDEO_FRAME',
        stream_index: probe.primary.index,
        pts,
        frame_identity_sha256: identity,
        decode_ordinal: selected.index,
        time_base_num: timeBase.num,
        time_base_den: timeBase.den,
        time_origin_pts: 0,
        actual_time_s: selected.time_s,
        width: probe.primary.width,
        height: probe.primary.height,
        transform_json: transformJson,
        transform_sha256: transformSha,
        pixel_sha256: pixelSha,
        quality_json: JSON.stringify(quality),
        created_at: nowIso(),
      })
    }

    const segmentId = `seg_${sha256Hex(`${taskId}:${media.media_id}:${startS}:${endS}`).slice(0, 20)}`
    const segmentStart = Math.max(0, Math.round((startS - probe.start_time_s) / (timeBase.num / timeBase.den)))
    const segmentEnd = Math.max(segmentStart, Math.round((endS - probe.start_time_s) / (timeBase.num / timeBase.den)))
    const coverage = [
      { kind: 'DECODED', json: { ranges: [{ start_s: startS, end_s: endS }], analysis_fps: 5, analyzed_frames: rangeFrames.length, decoded_frames: analysis.frames.length }, suffix: 'DECODED' },
      ...selection.selected.map((s: SelectedFrame) => ({
        kind: 'SAMPLED',
        json: { frame_id: frameIds[selection.selected.indexOf(s)], time_s: s.time_s, trigger: s.trigger, change_score: s.change_score, similarity_group_id: null },
        suffix: `SAMPLED:${s.time_s}`,
      })),
    ]
    return {
      result: {
        media_id: media.media_id,
        selection_mode: adaptive ? 'change' : 'fixed_interval_fallback',
        sampling: adaptive
          ? { change_threshold: sampling.change_threshold, min_frame_interval_s: sampling.min_frame_interval_s, max_frame_interval_s: sampling.max_frame_interval_s, scene_cut_threshold: sampling.scene_cut_threshold }
          : { overview_interval_s: sampling.overview_interval_s ?? input.interval_s ?? 5 },
        analyzed_frames: rangeFrames.length,
        decoded_frames: analysis.frames.length,
        kept_frames: selection.selected.length,
        scene_cuts: rangeAnalysis.scene_cuts.length,
        truncated: selection.truncated,
        frame_ids: frameIds,
      },
      artifacts,
      completion_scope: selection.truncated ? 'PARTIAL' : 'FULL',
      unprocessed_inputs: selection.truncated ? [`max_candidate_frames:${maxFrames}`] : [],
      apply: (registered) => {
        if (refreshProbe) {
          this.store.run(
            `update media set state='VERIFIED', width=?, height=?, duration_s=?, probe_json=? where media_id=?`,
            probe.primary.width, probe.primary.height, probe.duration_s, JSON.stringify(probe), String(media.media_id),
          )
        }
        this.store.run(
          `insert or ignore into segments(segment_id,task_id,media_id,stream_index,start_pts,end_pts,time_base_num,time_base_den,evidence_mode,evidence_json)
           values (?,?,?,?,?,?,?,?, 'SAMPLED_OBSERVATIONS', ?)`,
          segmentId, taskId, media.media_id, probe.primary.index, segmentStart, segmentEnd, timeBase.num, timeBase.den,
          JSON.stringify({ source: 'media.overview', selection_mode: adaptive ? 'change' : 'fixed_interval_fallback', analysis_fps: 5 }),
        )
        for (const row of frameRows) {
          if (!row.existing) {
            const artifact = registered.find((a) => a.artifact_id === row.artifact_id)
            if (!artifact) throw new DomainError('INTERNAL', 'frame artifact was not registered')
            this.store.run(
              `insert or ignore into frames(frame_id,media_id,artifact_id,frame_kind,stream_index,pts,frame_identity_sha256,decode_ordinal,time_base_num,time_base_den,time_origin_pts,actual_time_s,width,height,transform_json,transform_sha256,pixel_sha256,quality_json,created_at)
               values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              row.frame_id, row.media_id, row.artifact_id, row.frame_kind, row.stream_index, row.pts, row.frame_identity_sha256,
              row.decode_ordinal, row.time_base_num, row.time_base_den, row.time_origin_pts, row.actual_time_s,
              row.width, row.height, row.transform_json, row.transform_sha256, row.pixel_sha256, row.quality_json, row.created_at,
            )
          }
          this.store.run('insert or ignore into frame_segments(frame_id,segment_id) values (?,?)', row.frame_id, segmentId)
        }
        for (const item of coverage) {
          this.store.run(
            `insert or ignore into coverage_events(coverage_id,task_id,media_id,job_id,kind,coverage_json,created_at)
             values (?,?,?,?,?,?,?)`,
            `cov_${sha256Hex(`${claim.job_id}:${item.suffix}`).slice(0, 20)}`, taskId, media.media_id, claim.job_id, item.kind, JSON.stringify(item.json), nowIso(),
          )
        }
      },
    }
  }

  private async executeMediaSample(claim: ClaimedJob): Promise<ExecutedJob> {
    const { taskId, spec } = this.taskSpecFor(claim)
    const input = (claim.request.input ?? {}) as Dict
    const timestamps = (Array.isArray(input.timestamps_s) ? input.timestamps_s : []).map(Number)
    if (timestamps.length === 0) throw new DomainError('SCHEMA_INVALID', 'timestamps_s must not be empty')
    const media = this.requireMediaWithArtifact(String(input.media_id))
    const absolute = this.mediaAbsolutePath(media)
    const probe = probeFromStored(media) ?? await probeMedia(this.ffprobePath, absolute)
    if (probe.duration_s <= 0) throw new DomainError('MEDIA_PROBE_FAILED', 'video duration is zero or unknown')
    const timeBase = parseTimeBase(probe.primary.time_base)
    const transformJson = canonicalJson({ type: 'identity', width: probe.primary.width, height: probe.primary.height })
    const transformSha = sha256Hex(transformJson)
    const artifacts: ArtifactDraft[] = []
    const frameRows: Dict[] = []
    const frameIds: string[] = []
    const skipped: number[] = []
    for (const [ordinal, rawTime] of timestamps.entries()) {
      const timeS = Number(rawTime)
      if (!Number.isFinite(timeS) || timeS < 0 || timeS > probe.duration_s) { skipped.push(timeS); continue }
      const pts = Math.max(0, Math.round((timeS - probe.start_time_s) / (timeBase.num / timeBase.den)))
      const identity = sha256Hex(`${String(media.media_id)}:${probe.primary.index}:${pts}:${transformSha}`)
      const frameId = `frm_${identity.slice(0, 20)}`
      const existing = this.store.get<{ artifact_id: string }>('select artifact_id from frames where frame_identity_sha256=?', identity)
      if (existing) { frameIds.push(frameId); continue }
      const artifactId = `art_${sha256Hex(`${identity}:frame`).slice(0, 20)}`
      const relPath = `artifacts/${artifactId}/frame.png`
      const absoluteArtifact = join(this.dataDir, relPath)
      mkdirSync(join(this.dataDir, 'artifacts', artifactId), { recursive: true })
      await extractFrame(this.ffmpegPath, absolute, timeS, absoluteArtifact)
      const bytes = readFileSync(absoluteArtifact)
      const pixelSha = sha256Hex(bytes)
      artifacts.push({
        artifact_id: artifactId,
        kind: 'frame',
        relative_path: relPath,
        sha256: pixelSha,
        bytes: bytes.length,
        mime_type: 'image/png',
        metadata: { media_id: media.media_id, frame_id: frameId, time_s: timeS, trigger: 'FIXED_TIMESTAMP' },
        synthetic: Boolean(safeJson(media.metadata_json).synthetic),
      })
      frameRows.push({
        frame_id: frameId, artifact_id: artifactId, media_id: media.media_id, frame_kind: 'VIDEO_FRAME', stream_index: probe.primary.index,
        pts, frame_identity_sha256: identity, decode_ordinal: ordinal, time_base_num: timeBase.num, time_base_den: timeBase.den,
        time_origin_pts: 0, actual_time_s: timeS, width: probe.primary.width, height: probe.primary.height,
        transform_json: transformJson, transform_sha256: transformSha, pixel_sha256: pixelSha,
        quality_json: JSON.stringify({ selection_version: 'm2-fixed-v1', trigger: 'FIXED_TIMESTAMP', change_score: 0, scene_cut_score: 0, similarity_group_id: null }),
        created_at: nowIso(),
      })
      frameIds.push(frameId)
    }
    if (frameRows.length + frameIds.filter((id) => !frameRows.some((r) => r.frame_id === id)).length === 0) {
      throw new DomainError('SCHEMA_INVALID', 'no timestamp falls inside the video duration')
    }
    const minTime = Math.min(...timestamps.filter((t) => Number.isFinite(t) && t >= 0))
    const maxTime = Math.max(...timestamps.filter((t) => Number.isFinite(t) && t <= probe.duration_s))
    const segmentId = `seg_${sha256Hex(`${taskId}:${media.media_id}:sample`).slice(0, 20)}`
    return {
      result: { media_id: media.media_id, selection_mode: 'fixed_timestamps', requested: timestamps.length, kept_frames: frameIds.length, skipped, frame_ids: frameIds },
      artifacts,
      apply: (registered) => {
        this.store.run(
          `insert or ignore into segments(segment_id,task_id,media_id,stream_index,start_pts,end_pts,time_base_num,time_base_den,evidence_mode,evidence_json)
           values (?,?,?,?,?,?,?,?, 'SAMPLED_OBSERVATIONS', ?)`,
          segmentId, taskId, media.media_id, probe.primary.index,
          Math.max(0, Math.round((minTime - probe.start_time_s) / (timeBase.num / timeBase.den))),
          Math.max(0, Math.round((maxTime - probe.start_time_s) / (timeBase.num / timeBase.den))),
          timeBase.num, timeBase.den, JSON.stringify({ source: 'media.sample', selection_strategy: input.selection_strategy }),
        )
        for (const row of frameRows) {
          const artifact = registered.find((a) => a.artifact_id === row.artifact_id)
          if (!artifact) throw new DomainError('INTERNAL', 'frame artifact was not registered')
          this.store.run(
            `insert or ignore into frames(frame_id,media_id,artifact_id,frame_kind,stream_index,pts,frame_identity_sha256,decode_ordinal,time_base_num,time_base_den,time_origin_pts,actual_time_s,width,height,transform_json,transform_sha256,pixel_sha256,quality_json,created_at)
             values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            row.frame_id, row.media_id, row.artifact_id, row.frame_kind, row.stream_index, row.pts, row.frame_identity_sha256,
            row.decode_ordinal, row.time_base_num, row.time_base_den, row.time_origin_pts, row.actual_time_s,
            row.width, row.height, row.transform_json, row.transform_sha256, row.pixel_sha256, row.quality_json, row.created_at,
          )
          this.store.run('insert or ignore into frame_segments(frame_id,segment_id) values (?,?)', row.frame_id, segmentId)
        }
        for (const frameId of frameIds) {
          this.store.run(
            `insert or ignore into coverage_events(coverage_id,task_id,media_id,job_id,kind,coverage_json,created_at)
             values (?,?,?,?, 'SAMPLED', ?, ?)`,
            `cov_${sha256Hex(`${claim.job_id}:SAMPLED:${frameId}`).slice(0, 20)}`, taskId, media.media_id, claim.job_id,
            JSON.stringify({ frame_id: frameId, trigger: 'FIXED_TIMESTAMP', similarity_group_id: null }), nowIso(),
          )
        }
      },
    }
  }

  private requireMediaWithArtifact(mediaId: string): Dict {
    const media = this.store.get<Dict>('select * from media where media_id=?', mediaId)
    if (!media) throw new DomainError('NOT_FOUND', `media not found: ${mediaId}`)
    return media
  }

  private mediaAbsolutePath(media: Dict): string {
    const artifact = this.store.get<Dict>('select * from artifacts where artifact_id=?', media.artifact_id)
    if (!artifact) throw new DomainError('ARTIFACT_MISSING', `media artifact not found: ${media.artifact_id}`)
    const absolute = join(this.dataDir, String(artifact.relative_path))
    if (!existsSync(absolute)) throw new DomainError('ARTIFACT_MISSING', `media file does not exist: ${artifact.relative_path}`)
    const actual = sha256Hex(readFileSync(absolute))
    if (actual !== String(media.sha256) || actual !== String(artifact.sha256)) {
      throw new DomainError('ARTIFACT_HASH_MISMATCH', 'media file hash does not match the registered sha256')
    }
    return absolute
  }

  private resolveLocalMediaFile(locator: string): string {
    let candidate: string
    if (locator.startsWith('file://')) candidate = fileURLToPath(locator)
    else if (isAbsolute(locator)) candidate = locator
    else candidate = join(this.dataDir, 'inbox', locator)
    const inbox = join(this.dataDir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    const real = realpathSync(candidate)
    const rel = relative(realpathSync(inbox), real)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new DomainError('SCHEMA_INVALID', 'M2 local media must live under dataDir/inbox')
    }
    return real
  }

  // ---- M1.5 agent reads (operation_catalog.yaml, roles include agent) ----

  /** getSearchPlan: the stored search plan of the task's current revision. */
  getSearchPlan(taskId: string): Dict {
    const task = this.requireTask(taskId)
    const revision = Number(task.current_revision)
    const rows = this.store.all<{ query_id: string; query_json: string; plan_id: string }>(
      'select query_id, query_json, plan_id from search_queries where task_id=? and task_revision=? order by created_at, query_id',
      taskId, revision,
    )
    const queries = rows.map((r) => parseJson<Dict>(r.query_json, 'search query'))
    const searchPlanId = rows[0]?.plan_id ?? `plan_${taskId}_r${revision}`
    return this.contracts.assert<Dict>('SearchPlanData', {
      search_plan_id: searchPlanId,
      task_id: taskId,
      task_revision: revision,
      queries,
    })
  }

  /** listSourceVariants: mirror records for one source; URLs stay redacted. */
  listSourceVariants(sourceId: string): Dict {
    this.requireSource(sourceId)
    const rows = this.store.all<Dict>('select * from source_variants where source_id=? order by discovered_at, variant_id', sourceId)
    const variants = rows.map((v) => {
      const evidence = parseJson<Dict>(String(v.evidence_json), 'variant evidence')
      return {
        variant_id: v.variant_id,
        source_id: v.source_id,
        adapter_id: v.adapter_id,
        state: v.state,
        width: v.width,
        height: v.height,
        duration_s: v.duration_s,
        bytes: v.bytes,
        bitrate_bps: v.bitrate_bps,
        mime_type: v.mime_type,
        locator_key: v.locator_key,
        url_redacted: v.url_redacted,
        discovered_at: v.discovered_at,
        expires_at: v.expires_at,
        metadata_evidence_ids: Array.isArray(evidence.metadata_evidence_ids) ? evidence.metadata_evidence_ids : [],
      }
    })
    return this.contracts.assert<Dict>('SourceVariants', { source_id: sourceId, variants })
  }

  /** verifySource: record the evidence that raises a lead to PAGE_VERIFIED. */
  verifySource(raw: unknown, actor: string): Dict {
    const input = this.contracts.assert<Dict>('SourceVerification', raw)
    if (input.method === 'USER_SUPPLIED_RECORD') {
      throw new DomainError('FORBIDDEN', 'USER_SUPPLIED_RECORD can only be written by the user-side flow, not by an agent tool')
    }
    const source = this.requireSource(input.source_id)
    if (source.verification_state === 'DISPUTED') {
      throw new DomainError('INVALID_STATE', 'a disputed source cannot be verified by the agent')
    }
    for (const id of input.evidence_asset_ids as string[]) {
      if (!this.store.get('select 1 as x from artifacts where artifact_id=?', id)) {
        throw new DomainError('ARTIFACT_MISSING', `evidence asset does not exist: ${id}`)
      }
      if (!this.artifactBelongsToSource(id, input.source_id)) {
        throw new DomainError('REFERENCE_NOT_FOUND', `evidence asset ${id} does not belong to source ${input.source_id}`)
      }
    }
    const prior = this.store.all<Dict>('select * from source_verifications where source_id=? order by created_at', input.source_id)
      .find((row) => canonicalJson(parseJson(row.evidence_json, 'source verification')) === canonicalJson(input))
    if (prior) return this.mutationAck('source_verification', String(prior.verification_id), null, 'source.verified', String(prior.verification_id))
    const verificationId = newId('sv')
    const eventId = this.store.tx(() => {
      this.store.run(
        'insert into source_verifications(verification_id,source_id,method,evidence_json,verified_by,created_at) values (?,?,?,?,?,?)',
        verificationId, input.source_id, input.method, JSON.stringify(input), actor, nowIso(),
      )
      if (source.verification_state !== 'PAGE_VERIFIED') {
        this.store.run("update sources set verification_state='PAGE_VERIFIED', updated_at=? where source_id=?", nowIso(), input.source_id)
      }
      return this.store.audit(actor, 'source.verified', 'source_verification', verificationId, {
        source_id: input.source_id, method: input.method, observed_url: input.observed_url,
      })
    })
    return { entity_type: 'source_verification', entity_id: verificationId, revision: null, event_id: eventId }
  }

  /** recordQualityAssessment: a proposal record; never a review decision. */
  recordQualityAssessment(raw: unknown, actor: string): Dict {
    const input = this.contracts.assert<Dict>('QualityAssessmentCreate', raw)
    const task = this.requireTask(input.task_id)
    if (Number(input.task_revision) !== Number(task.current_revision)) {
      throw new DomainError('INVALID_STATE', `task revision ${input.task_revision} is not current ${task.current_revision}`)
    }
    const frame = this.store.get('select 1 as x from frames where frame_id=?', input.frame_id)
    if (!frame) throw new DomainError('NOT_FOUND', `frame not found: ${input.frame_id}`)
    for (const id of input.evidence_asset_ids as string[]) {
      if (!this.store.get('select 1 as x from artifacts where artifact_id=?', id)) {
        throw new DomainError('ARTIFACT_MISSING', `evidence asset does not exist: ${id}`)
      }
    }
    for (const id of input.observation_ids as string[]) {
      const obs = this.store.get<Dict>('select * from observations where observation_id=?', id)
      if (!obs) throw new DomainError('NOT_FOUND', `observation not found: ${id}`)
      if (String(obs.frame_id) !== input.frame_id || String(obs.task_id) !== input.task_id) {
        throw new DomainError('REFERENCE_NOT_FOUND', `observation ${id} does not belong to this frame and task`)
      }
    }
    const prior = this.store.all<Dict>('select * from quality_assessments where task_id=? and task_revision=? and frame_id=? and dimension=? and state=? order by created_at', input.task_id, input.task_revision, input.frame_id, input.dimension, input.state)
      .find((row) => canonicalJson(parseJson(row.evidence_json, 'quality assessment')) === canonicalJson(input))
    if (prior) return this.mutationAck('quality_assessment', String(prior.assessment_id), null, 'quality.assessed', String(prior.assessment_id))
    const assessmentId = newId('qa')
    const eventId = this.store.tx(() => {
      this.store.run(
        'insert into quality_assessments(assessment_id,task_id,task_revision,frame_id,dimension,state,actor_id,evidence_json,created_at) values (?,?,?,?,?,?,?,?,?)',
        assessmentId, input.task_id, input.task_revision, input.frame_id, input.dimension, input.state, actor, JSON.stringify(input), nowIso(),
      )
      return this.store.audit(actor, 'quality.assessed', 'quality_assessment', assessmentId, {
        task_id: input.task_id, frame_id: input.frame_id, dimension: input.dimension, state: input.state,
      })
    })
    return { entity_type: 'quality_assessment', entity_id: assessmentId, revision: null, event_id: eventId }
  }

  /** getFrame: one frame with its effective observation and review state. */
  getFrame(frameId: string, taskId?: string): Dict {
    return this.frameDetail(frameId, taskId)
  }

  /** listFrames: paged frames of a task, optionally filtered by frame kind. */
  listFrames(taskId: string, options: { cursor?: string | null; limit?: number; frame_kind?: string } = {}): Dict {
    this.requireTask(taskId)
    const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 200)
    const params: string[] = [taskId, taskId, taskId]
    const baseSql = `select distinct f.frame_id as frame_id from frames f join media_origins mo on mo.media_id=f.media_id join task_sources ts on ts.source_id=mo.source_id where ts.task_id=?
      union select distinct o.frame_id as frame_id from observations o where o.task_id=? and o.frame_id is not null
      union select distinct fs.frame_id as frame_id from frame_segments fs join segments s on s.segment_id=fs.segment_id where s.task_id=?`
    let sql: string
    if (options.frame_kind) {
      sql = `select x.frame_id as frame_id from (${baseSql}) x join frames f2 on f2.frame_id=x.frame_id where f2.frame_kind=? order by x.frame_id`
      params.push(options.frame_kind)
    } else {
      sql = `select x.frame_id as frame_id from (${baseSql}) x order by x.frame_id`
    }
    let ids = this.store.all<{ frame_id: string }>(sql, ...params).map((r) => r.frame_id)
    if (options.cursor) ids = ids.filter((id) => id > String(options.cursor))
    const page = ids.slice(0, limit)
    return {
      items: page.map((id) => this.frameDetail(id, taskId)),
      next_cursor: ids.length > limit ? page[page.length - 1] : null,
    }
  }

  /** listCoverage: decoded/sampled/delivered/reviewed ranges reported by jobs. */
  listCoverage(taskId: string, mediaId?: string): Dict {
    this.requireTask(taskId)
    const rows = mediaId
      ? this.store.all<Dict>('select * from coverage_events where task_id=? and media_id=? order by created_at, coverage_id', taskId, mediaId)
      : this.store.all<Dict>('select * from coverage_events where task_id=? order by created_at, coverage_id', taskId)
    const items = rows.map((r) => {
      const c = parseJson<Dict>(String(r.coverage_json), 'coverage')
      return {
        coverage_id: r.coverage_id,
        task_id: r.task_id,
        media_id: r.media_id,
        job_id: r.job_id,
        kind: r.kind,
        ranges: Array.isArray(c.ranges) ? c.ranges : [],
        frame_ids: Array.isArray(c.frame_ids) ? c.frame_ids : [],
        asset_ids: Array.isArray(c.asset_ids) ? c.asset_ids : [],
        seed: c.seed ?? null,
        created_at: r.created_at,
      }
    })
    return { items, next_cursor: null }
  }

  /** listSegments: media segments with the observations that cite them. */
  listSegments(mediaId: string): Dict {
    if (!this.store.get('select 1 as x from media where media_id=?', mediaId)) {
      throw new DomainError('NOT_FOUND', `media not found: ${mediaId}`)
    }
    const rows = this.store.all<Dict>('select * from segments where media_id=? order by stream_index, start_pts, segment_id', mediaId)
    const items = rows.map((s) => {
      const evidence = parseJson<Dict>(String(s.evidence_json), 'segment evidence')
      return {
        segment_id: s.segment_id,
        media_id: s.media_id,
        stream_index: Number(s.stream_index),
        start_pts: Number(s.start_pts),
        end_pts: Number(s.end_pts),
        time_base_num: Number(s.time_base_num),
        time_base_den: Number(s.time_base_den),
        evidence_mode: s.evidence_mode,
        observation_ids: Array.isArray(evidence.observation_ids) ? evidence.observation_ids : [],
      }
    })
    return { items, next_cursor: null }
  }

  /** listOverlaps: suggested or confirmed media overlaps for a task. */
  listOverlaps(taskId: string): Dict {
    this.requireTask(taskId)
    const rows = this.store.all<Dict>('select * from media_overlaps where task_id=? order by created_at, relation_id', taskId)
    const items = rows.map((r) => {
      const evidence = parseJson<Dict>(String(r.evidence_json), 'overlap evidence')
      return {
        relation_id: r.relation_id,
        left_segment_id: r.left_segment_id,
        right_segment_id: r.right_segment_id,
        status: r.status,
        evidence_asset_ids: Array.isArray(evidence.evidence_asset_ids) ? evidence.evidence_asset_ids : [],
        method: typeof evidence.method === 'string' ? evidence.method : 'unknown',
      }
    })
    return { items, next_cursor: null }
  }

  // ---- policy proposals and reads ----

  /** proposePolicy: a policy request for the user to decide; never a policy decision. */
  proposePolicy(raw: unknown, actor: string): Dict {
    const input = this.contracts.assert<Dict>('PolicyRequest', raw)
    if (input.task_id) this.requireTask(input.task_id)
    if (input.source_id) this.requireSource(input.source_id)
    const evidenceIds = [...(input.evidence_asset_ids as string[]), ...(input.basis.evidence_asset_ids as string[])]
    for (const id of evidenceIds) {
      if (!this.store.get('select 1 as x from artifacts where artifact_id=?', id)) {
        throw new DomainError('ARTIFACT_MISSING', `evidence asset does not exist: ${id}`)
      }
    }
    const requestJson = canonicalJson(input as Json)
    // The request_id is the explicit idempotency key: the same canonical request
    // always maps to the same primary key, so duplicate detection is one lookup
    // instead of a scan that compares every stored request body.
    const requestId = `pol_${sha256Hex(requestJson).slice(0, 20)}`
    const prior = this.store.get<Dict>('select * from policy_requests where request_id=?', requestId)
    if (prior) return this.mutationAck('policy_request', String(prior.request_id), null, 'policy.proposed', String(prior.request_id))
    const eventId = this.store.tx(() => {
      this.store.run(
        'insert into policy_requests(request_id,task_id,source_id,action,proposed_basis,evidence_json,status,created_at) values (?,?,?,?,?,?,?,?)',
        requestId, input.task_id, input.source_id, input.action, input.proposed_basis, JSON.stringify(input), 'PENDING', nowIso(),
      )
      return this.store.audit(actor, 'policy.proposed', 'policy_request', requestId, { action: input.action })
    })
    return { entity_type: 'policy_request', entity_id: requestId, revision: null, event_id: eventId }
  }

  listPolicyRequests(taskId?: string): Dict {
    const rows = taskId
      ? this.store.all<Dict>('select * from policy_requests where task_id=? order by created_at, request_id', taskId)
      : this.store.all<Dict>('select * from policy_requests order by created_at, request_id')
    const items = rows.map((r) => {
      const decision = this.store.get<{ decision_id: string }>(
        'select decision_id from policy_decisions where request_id=? order by created_at desc, rowid desc limit 1', r.request_id,
      )
      return {
        request_id: r.request_id,
        proposal: parseJson<Dict>(String(r.evidence_json), 'policy request'),
        status: r.status,
        decision_id: decision?.decision_id ?? null,
        created_at: r.created_at,
      }
    })
    return { items, next_cursor: null }
  }

  listPolicyRules(): Dict {
    const rows = this.store.all<Dict>('select * from policy_rules order by created_at, rule_id')
    const items = rows.map((r) => ({
      rule_id: r.rule_id,
      rule_version: Number(r.rule_version),
      rule: parseJson<Dict>(String(r.rule_json), 'policy rule'),
      enabled: Number(r.enabled) === 1,
      approved_at: r.created_at,
    }))
    return { items, next_cursor: null }
  }

  /** getBootstrap: what still needs the user before the workbench is ready. */
  getBootstrap(): Dict {
    const reviewerEnrolled = Number(this.store.get<{ c: number }>('select count(*) as c from reviewer_accounts where disabled=0')!.c) > 0
    const bootstrap = this.store.get<Dict>('select * from bootstrap_events order by config_revision desc, created_at desc limit 1')
    const now = nowIso()
    const activeRuleIds = this.store.all<{ rule_id: string }>(
      "select rule_id from policy_rules where enabled=1 and (expires_at is null or expires_at>?) order by created_at, rule_id", now,
    ).map((r) => r.rule_id)
    const missing: string[] = []
    if (!reviewerEnrolled) missing.push('reviewer_account')
    if (!bootstrap) missing.push('bootstrap_approval')
    if (activeRuleIds.length === 0) missing.push('policy_rule')
    const state = !reviewerEnrolled ? 'NEEDS_USER_SETUP' : missing.length === 0 ? 'READY' : 'PARTIAL'
    return {
      state,
      config_revision: bootstrap ? Number(bootstrap.config_revision) : 0,
      reviewer_enrolled: reviewerEnrolled,
      missing_items: missing,
      active_rule_ids: activeRuleIds,
    }
  }

  // ---- review and export reads ----

  listReviewBatches(taskId?: string): Dict {
    const rows = taskId
      ? this.store.all<Dict>('select * from review_batches where task_id=? order by created_at, batch_id', taskId)
      : this.store.all<Dict>('select * from review_batches order by created_at, batch_id')
    return { items: rows.map((r) => this.batchSummary(r)), next_cursor: null }
  }

  getReviewBatch(batchId: string): Dict {
    const row = this.store.get<Dict>('select * from review_batches where batch_id=?', batchId)
    if (!row) throw new DomainError('NOT_FOUND', `review batch not found: ${batchId}`)
    const items = this.store.all<Dict>('select * from review_items where batch_id=? order by frame_id', batchId).map((i) => {
      const decision = this.store.get<{ review_id: string }>(
        'select review_id from review_decisions where batch_id=? and frame_id=? order by revision desc, created_at desc limit 1', batchId, i.frame_id,
      )
      return {
        frame_id: i.frame_id,
        item_kind: i.item_kind,
        selection_id: i.selection_id,
        group_id: i.representative_group_id,
        effective_review_id: decision?.review_id ?? null,
        revision: Number(i.revision),
      }
    })
    return {
      summary: this.batchSummary(row),
      items,
      audit_seed: Number(row.audit_seed),
      blind_audit: Number(row.blind_audit) === 1,
      context_digest: row.context_digest,
      audit_shortfall: Number(row.audit_shortfall),
    }
  }

  getExport(exportId: string): Dict {
    const row = this.store.get<Dict>('select * from exports where export_id=?', exportId)
    if (!row) throw new DomainError('NOT_FOUND', `export not found: ${exportId}`)
    const snapshot = parseJson<Dict>(String(row.snapshot_json), 'export snapshot')
    return {
      export_id: row.export_id,
      batch_id: row.batch_id,
      export_kind: row.export_kind,
      manifest_artifact_id: row.manifest_artifact_id,
      artifact_ids: Array.isArray(snapshot.artifact_ids) ? snapshot.artifact_ids : [],
      included_frame_ids: Array.isArray(snapshot.included_frame_ids) ? snapshot.included_frame_ids : [],
      excluded: Array.isArray(snapshot.excluded) ? snapshot.excluded : [],
      annotation_complete: false,
      dataset_ready: false,
    }
  }

  listFeedback(taskId: string): Dict {
    this.requireTask(taskId)
    const rows = this.store.all<Dict>('select * from task_feedback where task_id=? order by created_at, feedback_id', taskId)
    const jobs = this.store.all<Dict>('select job_id, request_json from jobs where task_id=?', taskId)
    const items = rows.map((r) => {
      const feedback = parseJson<Dict>(String(r.feedback_json), 'task feedback')
      const frameIds = Array.isArray(feedback.frame_ids) ? feedback.frame_ids : []
      const childJobIds = jobs.filter((j) => {
        try {
          const request = JSON.parse(String(j.request_json)) as Dict
          const ids = request?.input?.feedback_ids
          return Array.isArray(ids) && ids.includes(r.feedback_id)
        } catch {
          return false
        }
      }).map((j) => String(j.job_id))
      return {
        feedback_id: r.feedback_id,
        task_id: r.task_id,
        feedback,
        status: r.status,
        case_set_version: Number(r.case_set_version),
        affected_frame_ids: frameIds,
        child_job_ids: childJobIds,
      }
    })
    return { items, next_cursor: null }
  }

  // ---- evidence import ----

  /** importEvidence: copy a local capture into the artifact store with its provenance. */
  importEvidence(raw: unknown, actor: string): Dict {
    const input = this.contracts.assert<Dict>('EvidenceImport', raw)
    this.requireSource(input.source_id)
    const rawPath = String(input.import_relative_path)
    const parts = rawPath.split(/[\\/]+/)
    if (isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath) || parts.includes('..')) {
      throw new DomainError('SCHEMA_INVALID', 'import_relative_path must be a relative path inside dataDir/inbox', {
        fieldErrors: [{ field: '/import_relative_path', message: 'path escapes the inbox directory' }],
      })
    }
    const root = realpathSync(resolve(this.dataDir))
    const inbox = join(root, 'inbox')
    if (!existsSync(inbox)) {
      throw new DomainError('NOT_FOUND', 'evidence inbox directory does not exist')
    }
    const inboxReal = realpathSync(inbox)
    const candidate = resolve(inboxReal, rawPath)
    const rel = relative(inboxReal, candidate)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new DomainError('SCHEMA_INVALID', 'import_relative_path must stay inside dataDir/inbox', {
        fieldErrors: [{ field: '/import_relative_path', message: 'path escapes the inbox directory' }],
      })
    }
    if (!existsSync(candidate)) {
      throw new DomainError('NOT_FOUND', `import file not found: ${input.import_relative_path}`)
    }
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new DomainError('SCHEMA_INVALID', 'symbolic links are not accepted as evidence imports', {
        fieldErrors: [{ field: '/import_relative_path', message: 'symbolic links are not allowed' }],
      })
    }
    const sourcePath = realpathSync(candidate)
    const realRel = relative(inboxReal, sourcePath)
    if (!realRel || realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new DomainError('SCHEMA_INVALID', 'resolved import path escapes dataDir/inbox', {
        fieldErrors: [{ field: '/import_relative_path', message: 'resolved path escapes the inbox directory' }],
      })
    }
    const info = statSync(sourcePath)
    if (!info.isFile()) {
      throw new DomainError('NOT_FOUND', `import file not found: ${input.import_relative_path}`)
    }
    if (info.size > this.evidenceMaxBytes) {
      throw new DomainError('FILE_TOO_LARGE', `import file exceeds the ${this.evidenceMaxBytes} byte limit`, {
        fieldErrors: [{ field: '/import_relative_path', message: `file is larger than ${this.evidenceMaxBytes} bytes` }],
      })
    }
    const bytes = readFileSync(sourcePath)
    if (bytes.length > this.evidenceMaxBytes) {
      throw new DomainError('FILE_TOO_LARGE', `import file exceeds the ${this.evidenceMaxBytes} byte limit`)
    }
    const digest = sha256Hex(bytes)
    const prior = this.store.all<Dict>('select * from artifacts where sha256=? order by created_at', digest).find((a) => {
      const metadata = parseJson<Dict>(String(a.metadata_json), 'artifact metadata')
      return metadata.source_id === input.source_id && metadata.import_relative_path === input.import_relative_path
    })
    if (prior) return this.mutationAck('artifact', String(prior.artifact_id), null, 'evidence.imported', String(prior.artifact_id))
    const artifactId = newId('art')
    const relativePath = `artifacts/${artifactId}/${basename(sourcePath)}`
    mkdirSync(join(root, 'artifacts', artifactId), { recursive: true })
    copyFileSync(sourcePath, join(root, relativePath))
    const eventId = this.store.tx(() => {
      this.store.run(
        'insert into artifacts(artifact_id,job_id,kind,relative_path,sha256,bytes,mime_type,metadata_json,synthetic,created_at) values (?,?,?,?,?,?,?,?,0,?)',
        artifactId, null, input.kind, relativePath, digest, bytes.length, mimeFor(sourcePath), JSON.stringify({
          source_id: input.source_id, captured_at: input.captured_at, page_url: input.page_url,
          preview_time_s: input.preview_time_s, capture_tool: input.capture_tool,
          import_relative_path: input.import_relative_path,
        }), nowIso(),
      )
      return this.store.audit(actor, 'evidence.imported', 'artifact', artifactId, { source_id: input.source_id, kind: input.kind, sha256: digest })
    })
    return { entity_type: 'artifact', entity_id: artifactId, revision: null, event_id: eventId }
  }

  // ---- private helpers ----

  private requireSource(sourceId: string): Dict {
    const source = this.store.get<Dict>('select * from sources where source_id=?', sourceId)
    if (!source) throw new DomainError('NOT_FOUND', `source not found: ${sourceId}`)
    return source
  }

  /**
   * An evidence artifact belongs to a source when its own provenance names that
   * source, when a source variant cites it, or when it is the stored file of
   * media acquired for that source.
   */
  private artifactBelongsToSource(artifactId: string, sourceId: string): boolean {
    const artifact = this.store.get<Dict>('select * from artifacts where artifact_id=?', artifactId)
    if (!artifact) return false
    const metadata = parseJson<Dict>(String(artifact.metadata_json), 'artifact metadata')
    if (metadata.source_id === sourceId) return true
    for (const row of this.store.all<Dict>('select evidence_json from source_variants where source_id=?', sourceId)) {
      const evidence = parseJson<Dict>(String(row.evidence_json), 'source variant evidence')
      if (Array.isArray(evidence.metadata_evidence_ids) && evidence.metadata_evidence_ids.includes(artifactId)) return true
    }
    return Boolean(this.store.get(
      'select 1 as x from media_origins mo join media m on m.media_id=mo.media_id where m.artifact_id=? and mo.source_id=?',
      artifactId, sourceId,
    ))
  }

  private mutationAck(entityType: string, entityId: string, revision: number | null, eventType: string, entityIdForAudit: string): Dict {
    const event = this.store.get<{ event_id: string }>(
      'select event_id from audit_events where entity_type=? and entity_id=? and event_type=? order by created_at desc limit 1',
      entityType, entityIdForAudit, eventType,
    )
    if (!event?.event_id) {
      throw new DomainError('AUDIT_EVENT_MISSING', `no audit event found for ${entityType}:${entityIdForAudit} (${eventType})`)
    }
    return { entity_type: entityType, entity_id: entityId, revision, event_id: event.event_id }
  }

  private batchSummary(row: Dict): Dict {
    const counts = (kind: string): number => Number(this.store.get<{ c: number }>('select count(*) as c from review_items where batch_id=? and item_kind=?', row.batch_id, kind)!.c)
    return {
      batch_id: row.batch_id,
      task_id: row.task_id,
      task_revision: Number(row.task_revision),
      status: row.status,
      candidate_count: counts('CANDIDATE'),
      audit_count: counts('AUDIT_REJECTED'),
      uncertain_count: counts('UNCERTAIN'),
      created_at: row.created_at,
    }
  }

  private frameDetail(frameId: string, taskId?: string): Dict {
    const frame = this.store.get<Dict>('select * from frames where frame_id=?', frameId)
    if (!frame) throw new DomainError('NOT_FOUND', `frame not found: ${frameId}`)
    const media = this.store.get<Dict>('select * from media where media_id=?', frame.media_id)
    if (!media) throw new DomainError('NOT_FOUND', `media not found: ${frame.media_id}`)
    const sourceIds = this.store.all<{ source_id: string }>('select distinct source_id from media_origins where media_id=? order by source_id', frame.media_id).map((r) => r.source_id)
    const allObservations = this.store.all<Dict>('select * from observations where frame_id=? order by created_at, observation_id', frameId)
    const latestObs = allObservations[allObservations.length - 1]
    const effectiveTaskId = taskId ?? (latestObs ? String(latestObs.task_id) : null)
    const observations = effectiveTaskId ? allObservations.filter((o) => String(o.task_id) === effectiveTaskId) : allObservations
    const observationIds = observations.map((o) => String(o.observation_id))
    const qualityRows = this.store.all<Dict>('select * from quality_assessments where frame_id=? order by created_at, assessment_id', frameId)
      .filter((q) => !effectiveTaskId || String(q.task_id) === effectiveTaskId)
    const segmentIds = this.store.all<{ segment_id: string }>('select segment_id from frame_segments where frame_id=? order by segment_id', frameId).map((r) => r.segment_id)
    const superseded = new Set<string>()
    for (const o of observations) {
      const list = parseJson<unknown>(String(o.supersedes_json), 'supersedes')
      if (Array.isArray(list)) for (const item of list) {
        if (typeof item === 'string') superseded.add(item)
        else if (item && typeof item === 'object' && typeof (item as Dict).observation_id === 'string') superseded.add((item as Dict).observation_id)
      }
    }
    const effective = observations.filter((o) => !superseded.has(String(o.observation_id)))
    const withLevel = (levels: string[]): Dict[] => effective.filter((o) => levels.includes(String(o.analysis_level)))
    const nativeOrRoi = withLevel(['native', 'roi'])
    const target = this.effectiveTarget(nativeOrRoi, effective)
    const viewpoint = this.effectiveViewpoint(nativeOrRoi, effective)
    for (const o of effective) {
      const conflicts = parseJson<unknown>(String(o.conflicts_json), 'conflicts')
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        // an explicitly recorded conflict outranks a single-object read
        if (target === 'PRESENT' || target === 'ABSENT_IN_CHECKED_VIEW') break
      }
    }
    const technical = qualityRows.filter((q) => q.dimension === 'technical').at(-1)
    const business = qualityRows.filter((q) => q.dimension === 'business').at(-1)
    const review = effectiveTaskId
      ? this.store.get<Dict>(
        `select d.* from review_decisions d join review_batches b on b.batch_id=d.batch_id
         where d.frame_id=? and b.task_id=? order by d.revision desc, d.created_at desc limit 1`, frameId, effectiveTaskId,
      )
      : this.store.get<Dict>('select * from review_decisions where frame_id=? order by revision desc, created_at desc limit 1', frameId)
    const reviewedCoverage = effectiveTaskId
      ? this.store.get('select 1 as x from coverage_events where task_id=? and media_id=? and kind in (\'VISUALLY_REVIEWED\',\'HUMAN_REVIEWED\') limit 1', effectiveTaskId, media.media_id)
      : undefined
    const sources = sourceIds.map((id) => this.store.get<Dict>('select * from sources where source_id=?', id)!).filter(Boolean)
    const blockers: string[] = []
    if (media.state !== 'VERIFIED') blockers.push('MEDIA_NOT_VERIFIED')
    if (frame.frame_kind === 'VIDEO_FRAME' && frame.pts === null) blockers.push('MISSING_PTS')
    if (target !== 'PRESENT') blockers.push('TARGET_NOT_PRESENT')
    if (viewpoint !== 'MATCH') blockers.push('VIEWPOINT_NOT_MATCH')
    if (!technical || technical.state !== 'USABLE') blockers.push('TECHNICAL_QUALITY_NOT_USABLE')
    if (sources.some((s) => s.verification_state !== 'PAGE_VERIFIED')) blockers.push('SOURCE_NOT_VERIFIED')
    if (sources.some((s) => s.capture_evidence_state !== 'SUPPORTED')) blockers.push('CAPTURE_EVIDENCE_NOT_SUPPORTED')
    const reviewReady = blockers.length === 0
    const acceptedExportable = reviewReady && review?.decision === 'ACCEPT' && business?.state === 'USABLE'
    const group = this.store.get<{ g: string | null }>('select representative_group_id as g from review_items where frame_id=? and representative_group_id is not null limit 1', frameId)
    const similar = group?.g
      ? this.store.all<{ frame_id: string }>('select distinct frame_id from review_items where representative_group_id=? and frame_id<>? order by frame_id', group.g, frameId).map((r) => r.frame_id)
      : []
    void reviewedCoverage
    return {
      frame_id: frame.frame_id,
      media_id: frame.media_id,
      artifact_id: frame.artifact_id,
      source_ids: sourceIds,
      width: Number(frame.width),
      height: Number(frame.height),
      pts: frame.pts === null ? null : Number(frame.pts),
      time_base_num: frame.time_base_num === null ? null : Number(frame.time_base_num),
      time_base_den: frame.time_base_den === null ? null : Number(frame.time_base_den),
      actual_time_s: frame.actual_time_s === null ? null : Number(frame.actual_time_s),
      observation_ids: observationIds,
      quality_assessment_ids: qualityRows.map((q) => String(q.assessment_id)),
      segment_ids: segmentIds,
      similar_frame_ids: similar,
      effective_target_state: target,
      effective_viewpoint_state: viewpoint,
      review_ready: reviewReady,
      accepted_exportable: acceptedExportable,
      blockers,
      frame_kind: frame.frame_kind,
    }
  }

  private effectiveTarget(nativeOrRoi: Dict[], all: Dict[]): string {
    const states = nativeOrRoi.map((o) => String(o.target_state))
    if (states.includes('PRESENT')) return 'PRESENT'
    if (states.includes('UNCERTAIN')) return 'UNCERTAIN'
    if (states.includes('UNREADABLE')) return 'UNREADABLE'
    if (states.length > 0 && states.every((s) => s === 'ABSENT_IN_CHECKED_VIEW')) {
      const coverage = this.store.get("select 1 as x from coverage_events where kind in ('VISUALLY_REVIEWED','HUMAN_REVIEWED') limit 1")
      return coverage ? 'ABSENT_IN_CHECKED_VIEW' : 'NOT_CHECKED'
    }
    if (states.length > 0) return 'NOT_CHECKED'
    const navigation = all.filter((o) => String(o.analysis_level) === 'navigation').map((o) => String(o.target_state))
    if (navigation.includes('PRESENT')) return 'NOT_CHECKED'
    if (navigation.includes('UNCERTAIN')) return 'UNCERTAIN'
    if (navigation.includes('UNREADABLE')) return 'UNREADABLE'
    return 'NOT_CHECKED'
  }

  private effectiveViewpoint(nativeOrRoi: Dict[], all: Dict[]): string {
    const states = nativeOrRoi.map((o) => String(o.viewpoint_state))
    if (states.includes('MATCH')) return 'MATCH'
    if (states.includes('MISMATCH')) return 'MISMATCH'
    if (states.includes('UNCERTAIN')) return 'UNCERTAIN'
    if (states.length > 0) return 'NOT_CHECKED'
    const navigation = all.filter((o) => String(o.analysis_level) === 'navigation').map((o) => String(o.viewpoint_state))
    if (navigation.includes('MATCH')) return 'NOT_CHECKED'
    if (navigation.includes('MISMATCH')) return 'MISMATCH'
    return 'NOT_CHECKED'
  }

  private readonly dataDir: string
  private readonly evidenceMaxBytes: number
  private readonly visionProbe: boolean
}

function parseJson<T>(text: unknown, what: string): T {
  try {
    return JSON.parse(String(text)) as T
  } catch {
    throw new DomainError('INTERNAL', `stored ${what} is not valid JSON`)
  }
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.json': return 'application/json'
    case '.html':
    case '.htm': return 'text/html'
    case '.txt': return 'text/plain'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.mkv': return 'video/x-matroska'
    case '.m4v': return 'video/x-m4v'
    case '.webm': return 'video/webm'
    default: return 'application/octet-stream'
  }
}

function targetDefined(target: unknown): boolean {
  const t = target as Dict | undefined
  return Boolean(t && typeof t.name === 'string' && t.name.trim() && typeof t.definition === 'string' && t.definition.trim())
}

function cap(adapter: string, operation: string, state: string, reason: string, checkedAt: string | null): Dict {
  return { adapter_id: adapter, platform_id: null, operation, state, checked_at: checkedAt, evidence_ids: [], reason }
}
