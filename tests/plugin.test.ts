import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { activeSpec, sourceInput, template } from './helpers.ts'

let dir: string
let ctx: Context
let fiber: { dispose(): unknown }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shijie-plugin-'))
  ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  ctx.plugin(SkillRegistry)
  fiber = ctx.plugin(plugin, { dataDir: dir, mode: 'assisted', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', journal: 'AUTO' })
  await new Promise((resolve) => setTimeout(resolve, 0))
})

afterEach(async () => {
  await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown>) {
  const result = await (ctx as any).tools.execute({ callId: `call_${Math.random()}`, name, arguments: args, signal: new AbortController().signal })
  return result
}

function envelope(result: any): any {
  expect(result.isError).toBe(false)
  expect(JSON.parse(result.content[0].text)).toEqual(result.value)
  return result.value
}

describe('plugin in a real Cordis context', () => {
  it('registers only agent-role tools', () => {
    const names = ((ctx as any).tools.schemas() as { name: string }[]).map((t) => t.name).sort()
    expect(names).toContain('shijie_task_create')
    expect(names).toContain('shijie_source_register')
    expect(names).toContain('shijie_job_run')
    expect(names.length).toBe(36)
    for (const name of [
      'shijie_search_plan',
      'shijie_source_variants',
      'shijie_source_verify',
      'shijie_quality_record',
      'shijie_frame_get',
      'shijie_frame_list',
      'shijie_coverage_list',
      'shijie_segment_list',
      'shijie_overlap_list',
      'shijie_policy_request_list',
      'shijie_policy_rule_list',
      'shijie_policy_propose',
      'shijie_bootstrap_get',
      'shijie_review_batch_list',
      'shijie_review_batch_get',
      'shijie_export_get',
      'shijie_feedback_list',
      'shijie_evidence_import',
    ]) {
      expect(names).toContain(name)
    }
    expect(names.every((n) => n.startsWith('shijie_'))).toBe(true)
    // Reads and proposals are agent tools; any user decision or enrollment entry is not.
    const forbidden = names.filter((n) =>
      /(_decide|_decision|_approve|_revise|_enroll|_login)$/.test(n) ||
      ['shijie_feedback_create', 'shijie_reference_import', 'shijie_observation_resolve', 'shijie_capture_decide'].includes(n),
    )
    expect(forbidden).toEqual([])
  })

  it('publishes the skill', async () => {
    const skill = await (ctx as any).skills.get('shijie-workbench')
    expect(skill?.content).toContain('shijie_task_create')
    expect(skill?.content.startsWith('---')).toBe(false)
  })

  it('runs a task through the tool pipeline', async () => {
    const tpl = envelope(await call('shijie_task_template', {}))
    expect(tpl.status).toBe('OK')
    expect(tpl.data.stage).toBe('draft')

    const draft = envelope(await call('shijie_task_create', { spec: template() }))
    expect(draft.data.summary.status).toBe('DRAFT')

    const created = envelope(await call('shijie_task_create', { spec: activeSpec() }))
    const id = created.data.summary.task_id
    expect(created.data.summary.status).toBe('READY')

    const src = envelope(await call('shijie_source_register', { source: sourceInput(id) }))
    expect(src.status).toBe('OK')
    expect(src.data.created).toBe(true)

    const next = envelope(await call('shijie_task_next', { task_id: id }))
    expect(next.data.action).toBe('SUBMIT_JOB')
    const job = envelope(await call('shijie_job_submit', { job: next.data.job_template }))
    expect(job.data.status).toBe('QUEUED')
    const blocked = envelope(await call('shijie_task_next', { task_id: id }))
    expect(blocked.data).toMatchObject({ action: 'REPORT_BLOCKED', reason_code: 'CAPABILITY_MISSING' })
  })

  it('returns domain failures as envelopes', async () => {
    const bad = envelope(await call('shijie_task_create', { spec: { task_name: 'x' } }))
    expect(bad.status).toBe('ERROR')
    expect(bad.code).toBe('SCHEMA_INVALID')
    expect(bad.data.field_errors.length).toBeGreaterThan(0)

    const draft = envelope(await call('shijie_task_create', { spec: template() }))
    const blocked = envelope(await call('shijie_source_register', { source: sourceInput(draft.data.summary.task_id) }))
    expect(blocked).toMatchObject({ status: 'BLOCKED', code: 'TARGET_NOT_DEFINED' })
  })

  it('rejects arguments that do not match the tool schema', async () => {
    const result = await call('shijie_task_get', {})
    expect(result.isError).toBe(true)
  })

  it('serves the exact contract schema', async () => {
    const r = envelope(await call('shijie_contract', { name: 'SourceCreate' }))
    expect(r.data.required).toContain('task_id')
    expect(envelope(await call('shijie_contract', { name: 'Nope' })).code).toBe('NOT_FOUND')
  })
})
