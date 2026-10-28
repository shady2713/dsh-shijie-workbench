import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, afterAll } from 'vitest'
import { loadContracts } from '../src/contracts.ts'
import { JobExecutor } from '../src/domain/executor.ts'
import { Store } from '../src/store.ts'
import { sha256Hex } from '../src/util.ts'
import { sourceInput, activeSpec, newWorkbench, template } from './helpers.ts'

const dirs: string[] = []
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shijie-m2-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function runFfmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true })
}

function makeSceneVideo(path: string): void {
  runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1.5:r=10',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1.5:r=10',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
    '-r', '10', '-y', path,
  ])
}

function planJob(taskId: string, client = 'plan-1') {
  return { task_id: taskId, kind: 'search.plan', client_request_id: client, input: { feedback_ids: [] } }
}

describe('v1.3 contract', () => {
  it('accepts v1.2 tasks and v1.3 tasks with new defaults', () => {
    const contracts = loadContracts()
    const accepted = contracts.def('AcceptedFrameManifest') as { properties: Record<string, { enum?: string[] }> }
    const review = contracts.def('ReviewFrameManifest') as { properties: Record<string, { enum?: string[] }> }
    expect(accepted.properties.similarity_group_id).toBeTruthy()
    expect(review.properties.similarity_group_id).toBeTruthy()
    expect(accepted.properties.schema_version?.enum).toEqual(['1.2', '1.3'])
    expect(review.properties.schema_version?.enum).toEqual(['1.2', '1.3'])
    const v12 = template()
    v12.schema_version = '1.2'
    expect(contracts.assert('TaskSpec', v12)).toBeTruthy()

    const v13 = template()
    delete v13.sampling.overview_interval_s
    delete v13.sampling.candidate_interval_s
    delete v13.sampling.burst_interval_s
    expect(contracts.assert('TaskSpec', v13)).toBeTruthy()
    expect(v13.sampling.change_threshold).toBe(0.35)

    const bad = template()
    bad.sampling.change_threshold = 1.5
    expect(() => contracts.assert('TaskSpec', bad)).toThrow()
  })

  it('rejects max_frame_interval_s below min_frame_interval_s', () => {
    const wb = newWorkbench()
    const spec = activeSpec()
    spec.sampling.min_frame_interval_s = 2
    spec.sampling.max_frame_interval_s = 1
    expect(() => wb.createTask(spec, 'agent')).toThrow(/max_frame_interval_s/)
  })

  it('rejects a v1.2 task that lacks fixed-interval fields', () => {
    const contracts = loadContracts()
    const v12 = template()
    v12.schema_version = '1.2'
    delete v12.sampling.overview_interval_s
    expect(() => contracts.assert('TaskSpec', v12)).toThrow()
  })

  it('keeps a stored 1.2 operation payload readable and rejects unknown versions', () => {
    const contracts = loadContracts()
    const legacy = {
      schema_version: '1.2',
      status: 'OK',
      code: 'OK',
      message: 'legacy row',
      job_id: null,
      data: { empty: true, reason: 'legacy' },
      artifacts: [],
      retryable: false,
    }
    expect(contracts.assert('OperationResult', legacy)).toBeTruthy()
    expect(() => contracts.assert('OperationResult', { ...legacy, schema_version: '1.0' })).toThrow()
  })
})

describe('1.2 to 1.3 migration', () => {
  it('upgrades an old jobs table and keeps old payloads readable', () => {
    const dir = dataDir()
    const path = join(dir, 'old.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`
      create table schema_migrations(version text primary key, applied_at text not null);
      insert into schema_migrations values ('1.2', '2026-01-01T00:00:00Z');
      create table jobs(job_id text primary key, status text not null, max_attempts integer not null default 3);
      insert into jobs values ('job_old', 'QUEUED', 3);
    `)
    old.close()

    const store = new Store({ path })
    const columns = store.all<{ name: string }>('pragma table_info(jobs)').map((c) => c.name)
    expect(columns).toContain('claim_generation')
    expect(store.get<{ version: string }>('select max(version) as version from schema_migrations')?.version).toBe('1.3')
    expect(store.get<{ job_id: string }>('select job_id from jobs')?.job_id).toBe('job_old')
    store.close()
  })
})

describe('job executor leases', () => {
  it('increments claim_generation and refuses a stale claim after expiry', async () => {
    const dir = dataDir()
    const wb = newWorkbench({ dataDir: dir })
    const taskId = wb.createTask(activeSpec(), 'agent').summary.task_id
    const job = wb.submitJob(planJob(taskId), 'agent')
    const executor = new JobExecutor(wb.store, dir)
    const first = executor.claimNext('worker-a', -1, ['search.plan'])
    expect(first?.job_id).toBe(job.job_id)
    expect(first?.claim_generation).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = executor.claimNext('worker-b', 60_000, ['search.plan'])
    expect(second?.claim_generation).toBe(2)
    expect(() => executor.complete(first!, { result: {}, artifacts: [] })).toThrow(/stale/)
    expect(() => executor.heartbeat(first!, 60_000)).toThrow(/lease/)
    expect(executor.heartbeat(second!, 60_000)).toBeTruthy()
    const done = executor.complete(second!, { result: { ok: true }, artifacts: [] })
    expect(done.already_completed).toBe(false)
    expect(wb.getJob(job.job_id).status).toBe('SUCCEEDED')
    const events = wb.store.all<{ c: number }>("select count(*) as c from workflow_events where event_type='job.completed'")
    expect(events[0]?.c).toBe(1)
  })

  it('does not allow the same completion to count twice', async () => {
    const dir = dataDir()
    const wb = newWorkbench({ dataDir: dir })
    const taskId = wb.createTask(activeSpec(), 'agent').summary.task_id
    const job = wb.submitJob(planJob(taskId), 'agent')
    const executor = new JobExecutor(wb.store, dir)
    const claim = executor.claimNext('worker-a', 60_000, ['search.plan'])!
    executor.complete(claim, { result: { n: 1 }, artifacts: [] })
    const again = executor.complete(claim, { result: { n: 1 }, artifacts: [] })
    expect(again.already_completed).toBe(true)
    expect(wb.store.all<{ c: number }>("select count(*) as c from workflow_events where event_type='job.completed'")[0]?.c).toBe(1)
    expect(wb.getJob(job.job_id).status).toBe('SUCCEEDED')
  })
})

describe('media jobs', () => {
  it('acquires, probes and samples a local official file with verified hashes', async () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    const video = join(dir, 'inbox', 'scene.mp4')
    makeSceneVideo(video)

    const wb = newWorkbench({ dataDir: dir })
    const taskId = wb.createTask(activeSpec(), 'agent').summary.task_id
    const source = wb.registerSource(sourceInput(taskId), 'agent')
    const sourceId = source.source.source_id
    const variantId = 'var_local_1'
    wb.store.run(
      `insert into source_variants(variant_id,source_id,adapter_id,state,locator_key,url_redacted,evidence_json,discovered_at)
       values (?,?,?,?,?,?,?,?)`,
      variantId, sourceId, 'agent_browser', 'VERIFIED', `file://${video.replaceAll('\\', '/')}`, 'local:test', '{}', '2026-01-01T00:00:00Z',
    )

    const acquire = wb.submitJob({
      task_id: taskId, kind: 'media.acquire', client_request_id: 'acq-1',
      input: { source_id: sourceId, strategy: 'official_file', variant_id: variantId, max_bytes: 10_000_000 },
    }, 'agent')
    const acqRun = await wb.runJobs(1)
    expect(acqRun[0]).toMatchObject({ job_id: acquire.job_id, status: 'SUCCEEDED' })
    const mediaId = String(acqRun[0]!.result.media_id)
    const media = wb.store.get<any>('select * from media where media_id=?', mediaId)
    expect(media.state).toBe('ACQUIRED')
    const artifact = wb.store.get<any>('select * from artifacts where artifact_id=?', media.artifact_id)
    const artifactPath = join(dir, String(artifact.relative_path))
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath).length).toBe(artifact.bytes)
    expect(sha256Hex(readFileSync(artifactPath))).toBe(String(artifact.sha256))
    expect(sha256Hex(readFileSync(artifactPath))).toBe(String(media.sha256))

    const probe = wb.submitJob({
      task_id: taskId, kind: 'media.probe', client_request_id: 'probe-1',
      input: { media_id: mediaId, validate_ranges: [] },
    }, 'agent')
    const probeRun = await wb.runJobs(1)
    expect(probeRun[0]).toMatchObject({ job_id: probe.job_id, status: 'SUCCEEDED' })
    expect(probeRun[0]!.result.cfr).toBe(true)
    expect(Number(probeRun[0]!.result.duration_s)).toBeGreaterThan(2.5)

    const overview = wb.submitJob({
      task_id: taskId, kind: 'media.overview', client_request_id: 'ov-1',
      input: { media_id: mediaId, interval_s: 1, start_s: 0, end_s: 3 },
    }, 'agent')
    const ovRun = await wb.runJobs(1)
    expect(ovRun[0]).toMatchObject({ job_id: overview.job_id, status: 'SUCCEEDED' })
    expect(Number(ovRun[0]!.result.kept_frames)).toBeGreaterThan(0)
    expect(Number(ovRun[0]!.result.kept_frames)).toBeLessThanOrEqual(3)
    const frames = wb.store.all<any>('select * from frames order by decode_ordinal')
    expect(frames.length).toBe(Number(ovRun[0]!.result.kept_frames))
    const triggers = frames.map((frame) => JSON.parse(String(frame.quality_json)).trigger)
    expect(triggers).toContain('FIRST_FRAME')
    expect(triggers).toContain('SCENE_CUT')
    expect(Number(ovRun[0]!.result.scene_cuts)).toBe(triggers.filter((trigger) => trigger === 'SCENE_CUT').length)
    for (const frame of frames) {
      const quality = JSON.parse(String(frame.quality_json))
      expect(quality.trigger).toBeTruthy()
      expect(quality.selection_version).toBe('m2-change-v1')
      expect(typeof quality.change_score).toBe('number')
      expect(typeof quality.scene_cut_score).toBe('number')
      expect(existsSync(join(dir, String(wb.store.get<any>('select relative_path from artifacts where artifact_id=?', frame.artifact_id).relative_path)))).toBe(true)
    }
    expect(wb.store.all<{ c: number }>("select count(*) as c from coverage_events where kind='SAMPLED'")[0]?.c).toBe(frames.length)

    const sample = wb.submitJob({
      task_id: taskId, kind: 'media.sample', client_request_id: 'sample-1',
      input: { media_id: mediaId, timestamps_s: [0.2, 1.2, 2.4], selection_strategy: 'first_at_or_after' },
    }, 'agent')
    const sampleRun = await wb.runJobs(1)
    expect(sampleRun[0]).toMatchObject({ job_id: sample.job_id, status: 'SUCCEEDED' })
    expect(Number(sampleRun[0]!.result.kept_frames)).toBe(3)
    expect(wb.listFrames(taskId).items.length).toBeGreaterThanOrEqual(frames.length + 3)
  })

  it('recovers a claimed media job after the worker process dies', async () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'inbox'), { recursive: true })
    const video = join(dir, 'inbox', 'crash.mp4')
    makeSceneVideo(video)

    const wb = newWorkbench({ dataDir: dir, store: new Store({ path: join(dir, 'workbench.sqlite') }) })
    const taskId = wb.createTask(activeSpec(), 'agent').summary.task_id
    const source = wb.registerSource(sourceInput(taskId), 'agent')
    const sourceId = source.source.source_id
    wb.store.run(
      `insert into source_variants(variant_id,source_id,adapter_id,state,locator_key,url_redacted,evidence_json,discovered_at)
       values (?,?,?,?,?,?,?,?)`,
      'var_crash', sourceId, 'agent_browser', 'VERIFIED', `file://${video.replaceAll('\\', '/')}`, 'local:test', '{}', '2026-01-01T00:00:00Z',
    )
    const job = wb.submitJob({
      task_id: taskId, kind: 'media.acquire', client_request_id: 'acq-crash',
      input: { source_id: sourceId, strategy: 'official_file', variant_id: 'var_crash', max_bytes: 10_000_000 },
    }, 'agent')

    execFileSync(process.execPath, [join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs'), 'tests/fixtures/crash-worker.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, SHIJIE_DB: join(dir, 'workbench.sqlite'), SHIJIE_DATA: dir },
      stdio: 'pipe',
    })

    const claimed = wb.store.get<any>('select * from jobs where job_id=?', job.job_id)
    expect(claimed.status).toBe('RUNNING')
    expect(claimed.claim_generation).toBe(1)
    wb.store.run("update jobs set lease_expires_at='1970-01-01T00:00:00.000Z' where job_id=?", job.job_id)

    const recovered = await wb.runJobs(1)
    expect(recovered[0]).toMatchObject({ job_id: job.job_id, status: 'SUCCEEDED' })
    expect(recovered[0]!.attempt).toBe(2)
    const mediaRows = wb.store.all<any>('select * from media')
    expect(mediaRows).toHaveLength(1)
    const artifacts = wb.store.all<any>('select * from artifacts where kind=\'media\'')
    expect(artifacts).toHaveLength(1)
    const artifactPath = join(dir, String(artifacts[0]!.relative_path))
    expect(existsSync(artifactPath)).toBe(true)
    expect(readFileSync(artifactPath).length).toBe(artifacts[0]!.bytes)
    expect(sha256Hex(readFileSync(artifactPath))).toBe(String(artifacts[0]!.sha256))
    expect(sha256Hex(readFileSync(artifactPath))).toBe(String(mediaRows[0]!.sha256))
    expect(wb.store.get<any>('select claim_generation from jobs where job_id=?', job.job_id).claim_generation).toBe(2)
    expect(await wb.runJobs(1)).toEqual([])
    wb.store.close()
  })
})
