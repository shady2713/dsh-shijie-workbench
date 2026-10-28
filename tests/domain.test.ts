import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadContracts } from '../src/contracts.ts'
import { Store, walFixVerified } from '../src/store.ts'
import { DomainError, canonicalUrlKey } from '../src/util.ts'
import { activeSpec, newWorkbench, sourceInput, template } from './helpers.ts'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  return 'NO_ERROR'
}

describe('contracts', () => {
  const contracts = loadContracts()

  it('compiles every definition', () => {
    expect(contracts.defs().length).toBeGreaterThan(100)
    for (const name of contracts.defs()) {
      if (name.startsWith('Response_') || name === 'JobRequest' || /^[A-Z]/.test(name)) {
        expect(() => contracts.def(name)).not.toThrow()
      }
    }
  })

  it('accepts the default template and rejects a broken spec', () => {
    expect(() => contracts.assert('TaskSpec', template())).not.toThrow()
    const bad = template()
    delete bad.limits
    expect(codeOf(() => contracts.assert('TaskSpec', bad))).toBe('SCHEMA_INVALID')
  })

  it('rejects an unknown definition', () => {
    expect(codeOf(() => contracts.def('Nope'))).toBe('NOT_FOUND')
  })
})

describe('store', () => {
  it('creates the v1.3 schema once and records it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shijie-store-'))
    try {
      const path = join(dir, 'a', 'db.sqlite')
      const first = new Store({ path })
      expect(first.get<{ version: string }>('select version from schema_migrations')?.version).toBe('1.3')
      first.close()
      const second = new Store({ path })
      expect(second.all('select version from schema_migrations')).toHaveLength(1)
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enables WAL only on fixed SQLite versions', () => {
    expect(walFixVerified('3.51.2')).toBe(false)
    expect(walFixVerified('3.51.3')).toBe(true)
    expect(walFixVerified('3.50.6')).toBe(false)
    expect(walFixVerified('3.50.7')).toBe(true)
    expect(walFixVerified('3.44.6')).toBe(true)
    expect(walFixVerified('3.45.0')).toBe(false)
    expect(walFixVerified('3.53.0')).toBe(true)
  })
})

describe('util', () => {
  it('drops tracking parameters and fragments from URL keys', () => {
    expect(canonicalUrlKey('https://Example.test/a/?b=2&utm_source=x&a=1#frag')).toBe('https://example.test/a?a=1&b=2')
  })
})

describe('tasks', () => {
  it('stores a draft task that cannot run', () => {
    const wb = newWorkbench()
    const task = wb.createTask(template(), 'agent')
    expect(task.summary.status).toBe('DRAFT')
    expect(task.blockers.map((b: any) => b.code)).toContain('TARGET_NOT_DEFINED')
    const id = task.summary.task_id
    expect(codeOf(() => wb.resumeTask(id, 'agent'))).toBe('TARGET_NOT_DEFINED')
    expect(codeOf(() => wb.registerSource(sourceInput(id), 'agent'))).toBe('TARGET_NOT_DEFINED')
    expect(codeOf(() => wb.submitJob({ task_id: id, kind: 'search.plan', client_request_id: 'x', input: { feedback_ids: [] } }, 'agent'))).toBe('TARGET_NOT_DEFINED')
  })

  it('refuses an active task without a target', () => {
    const wb = newWorkbench()
    const spec = template()
    spec.stage = 'active'
    expect(codeOf(() => wb.createTask(spec, 'agent'))).toBe('TARGET_NOT_DEFINED')
  })

  it('creates an active task as READY and lists it', () => {
    const wb = newWorkbench()
    const task = wb.createTask(activeSpec(), 'agent')
    expect(task.summary.status).toBe('READY')
    expect(task.budgets[0]).toMatchObject({ resource_key: 'source_count', limit_units: 120, remaining_units: 120 })
    expect(wb.listTasks()).toHaveLength(1)
    expect(codeOf(() => wb.getTask('missing'))).toBe('NOT_FOUND')
  })

  it('closes an empty task only as partial and blocks while a job is live', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const job = wb.submitJob({ task_id: id, kind: 'search.plan', client_request_id: 'p1', input: { feedback_ids: [] } }, 'agent')
    expect(codeOf(() => wb.closeTask(id, 'agent'))).toBe('CLOSE_BLOCKED')
    wb.cancelJob(job.job_id, 'agent')
    expect(wb.closeTask(id, 'agent').summary.status).toBe('CLOSED_PARTIAL')
    expect(codeOf(() => wb.registerSource(sourceInput(id), 'agent'))).toBe('INVALID_STATE')
  })
})

describe('sources', () => {
  it('registers once, is idempotent per discovery, and merges tracking-parameter duplicates', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const first = wb.registerSource(sourceInput(id), 'agent')
    expect(first.created).toBe(true)

    const repeat = wb.registerSource(sourceInput(id), 'agent')
    expect(repeat.created).toBe(false)
    expect(repeat.discovery_id).toBe(first.discovery_id)

    const dup = wb.registerSource(
      sourceInput(id, { canonical_url: 'https://example.test/watch?v=abc&fbclid=zzz', client_discovery_id: 'disc-2' }),
      'agent',
    )
    expect(dup.created).toBe(false)
    expect(dup.source.source_id).toBe(first.source.source_id)
    expect(dup.source.discovery_ids).toHaveLength(2)
    expect(wb.listSources(id)).toHaveLength(1)
    expect(wb.getTask(id).summary.counts.sources).toBe(1)
  })

  it('dedupes by platform item id and keeps media kind fixed', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const a = wb.registerSource(sourceInput(id, { platform_item_id: 'item-9' }), 'agent')
    const b = wb.registerSource(
      sourceInput(id, { platform_item_id: 'item-9', canonical_url: 'https://example.test/other', client_discovery_id: 'd2' }),
      'agent',
    )
    expect(b.source.source_id).toBe(a.source.source_id)
    expect(codeOf(() => wb.registerSource(sourceInput(id, { platform_item_id: 'item-9', client_discovery_id: 'd3', media_kind: 'IMAGE' }), 'agent'))).toBe('SCHEMA_INVALID')
  })

  it('enforces the source budget', () => {
    const wb = newWorkbench()
    const spec = activeSpec()
    spec.limits.max_sources = 1
    const id = wb.createTask(spec, 'agent').summary.task_id
    wb.registerSource(sourceInput(id), 'agent')
    const err = codeOf(() => wb.registerSource(sourceInput(id, { canonical_url: 'https://example.test/second', client_discovery_id: 'd2' }), 'agent'))
    expect(err).toBe('BUDGET_EXCEEDED')
  })

  it('rejects missing evidence assets and bad input', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    expect(codeOf(() => wb.registerSource(sourceInput(id, { evidence_asset_ids: ['art_missing'] }), 'agent'))).toBe('ARTIFACT_MISSING')
    expect(codeOf(() => wb.registerSource({ task_id: id }, 'agent'))).toBe('SCHEMA_INVALID')
    expect(codeOf(() => wb.registerSource(sourceInput('nope'), 'agent'))).toBe('NOT_FOUND')
  })
})

describe('capture assessment proposals', () => {
  function proposal(sourceId: string, over: Record<string, any> = {}): Record<string, any> {
    return {
      source_id: sourceId,
      media_id: null,
      segment_ids: [],
      proposed_state: 'UNKNOWN',
      basis_kind: 'UPLOADER_CLAIM',
      evidence_asset_ids: [],
      reference_urls: [],
      explanation: 'uploader says drone',
      content_kind: 'UNKNOWN',
      ...over,
    }
  }

  it('records a proposal and refuses visual-only SUPPORTED', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const src = wb.registerSource(sourceInput(id), 'agent').source.source_id
    const ack = wb.proposeCapture(proposal(src), 'agent')
    expect(ack.entity_type).toBe('capture_assessment')
    expect(wb.getSource(src).assessment_ids).toHaveLength(1)
    expect(codeOf(() => wb.proposeCapture(proposal(src, { basis_kind: 'VISUAL_ONLY', proposed_state: 'SUPPORTED' }), 'agent'))).toBe('SCHEMA_INVALID')
    expect(codeOf(() => wb.proposeCapture(proposal('src_missing'), 'agent'))).toBe('NOT_FOUND')
  })

  it('does not change the source capture state', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const src = wb.registerSource(sourceInput(id), 'agent').source.source_id
    const before = wb.getSource(src).capture_evidence_state
    wb.proposeCapture(proposal(src, { proposed_state: 'SUPPORTED', basis_kind: 'INDEPENDENT_SOURCE_RECORD', reference_urls: ['https://example.test/record'] }), 'agent')
    expect(wb.getSource(src).capture_evidence_state).toBe(before)
  })
})

describe('jobs and next action', () => {
  const planJob = (id: string, rid = 'p1') => ({ task_id: id, kind: 'search.plan', client_request_id: rid, input: { feedback_ids: [] } })

  it('is idempotent per client_request_id and rejects a changed request', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const a = wb.submitJob(planJob(id), 'agent')
    const b = wb.submitJob(planJob(id), 'agent')
    expect(b.job_id).toBe(a.job_id)
    expect(a.status).toBe('QUEUED')
    const changed = { ...planJob(id), input: { feedback_ids: ['fb1'] } }
    expect(codeOf(() => wb.submitJob(changed, 'agent'))).toBe('IDEMPOTENCY_CONFLICT')
    expect(wb.listJobs(id)).toHaveLength(1)
  })

  it('cancels a queued job once and refuses a finished one', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const job = wb.submitJob(planJob(id), 'agent')
    expect(wb.cancelJob(job.job_id, 'agent').status).toBe('CANCELLED')
    expect(wb.cancelJob(job.job_id, 'agent').status).toBe('CANCELLED')
    expect(codeOf(() => wb.cancelJob('job_missing', 'agent'))).toBe('NOT_FOUND')
  })

  it('reports the real next step and never claims the missing executor', () => {
    const wb = newWorkbench()
    const draft = wb.createTask(template(), 'agent').summary.task_id
    expect(wb.nextAction(draft)).toMatchObject({ action: 'REPORT_BLOCKED', reason_code: 'TARGET_NOT_DEFINED' })

    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    const first = wb.nextAction(id)
    expect(first).toMatchObject({ action: 'SUBMIT_JOB', reason_code: 'NO_PLAN_YET' })
    expect(first.job_template.kind).toBe('search.plan')

    const job = wb.submitJob(first.job_template, 'agent')
    expect(wb.nextAction(id)).toMatchObject({ action: 'REPORT_BLOCKED', reason_code: 'CAPABILITY_MISSING', blocking_ids: [job.job_id] })
    expect(wb.getTask(id).blockers.map((b: any) => b.code)).toContain('CAPABILITY_MISSING')

    wb.cancelJob(job.job_id, 'agent')
    wb.closeTask(id, 'agent')
    expect(wb.nextAction(id)).toMatchObject({ action: 'REPORT_BLOCKED', reason_code: 'TASK_CLOSED' })
  })
})

describe('dashboard', () => {
  it('returns read-only counts and recent rows without changing state', () => {
    const wb = newWorkbench()
    const id = wb.createTask(activeSpec(), 'agent').summary.task_id
    wb.submitJob({ task_id: id, kind: 'search.plan', client_request_id: 'dash-1', input: { feedback_ids: [] } }, 'agent')

    const first = wb.dashboard()
    const second = wb.dashboard()
    expect(first.schema_version).toBe('1.3')
    expect(first.totals).toMatchObject({ tasks: 1, tasks_active: 1, jobs: 1, jobs_live: 1, media: 0, frames: 0 })
    expect(first.job_status).toMatchObject({ QUEUED: 1 })
    expect(first.recent_tasks[0]).toMatchObject({ task_id: id, name: 'test task', status: 'READY' })
    expect(first.recent_jobs[0]).toMatchObject({ task_id: id, kind: 'search.plan', status: 'QUEUED', attempt: 0, max_attempts: 3 })
    expect(first.recent_events.length).toBeGreaterThanOrEqual(2)
    expect(second.totals).toEqual(first.totals)
  })
})

describe('capabilities', () => {
  it('reports unimplemented parts as unsupported or unconfigured', async () => {
    const wb = newWorkbench()
    const caps = await wb.capabilities()
    const state = (adapter: string) => caps.find((c) => c.adapter_id === adapter)?.state
    expect(state('store')).toBe('AVAILABLE')
    expect(state('job_executor')).toBe('AVAILABLE')
    expect(state('reviewer_surface')).toBe('UNSUPPORTED')
    expect(state('host_vision')).toBe('UNCONFIGURED')
    expect(wb.contracts.assert('CapabilityRecord', caps[0])).toBeTruthy()
  })

  it('reports host vision available when the E1 probe is enabled', async () => {
    const wb = newWorkbench({ visionProbe: true })
    const caps = await wb.capabilities()
    const hostVision = caps.find((c) => c.adapter_id === 'host_vision')
    expect(hostVision?.state).toBe('AVAILABLE')
    expect(hostVision?.reason).toContain('E1 verified')
    expect(wb.contracts.assert('CapabilityRecord', hostVision)).toBeTruthy()
  })
})
