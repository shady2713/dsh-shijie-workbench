import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { loadContracts, CONTRACTS_DIR } from '../src/contracts.ts'
import { Workbench, type WorkbenchOptions } from '../src/domain/workbench.ts'
import { Store } from '../src/store.ts'

export function newWorkbench(overrides: Partial<WorkbenchOptions> = {}): Workbench {
  return new Workbench({
    store: new Store({ path: ':memory:' }),
    contracts: loadContracts(),
    mode: 'assisted',
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ...overrides,
  })
}

export function template(): Record<string, any> {
  return parse(readFileSync(new URL('task.template.yaml', CONTRACTS_DIR), 'utf8'))
}

export function activeSpec(): Record<string, any> {
  const spec = template()
  spec.stage = 'active'
  spec.task_name = 'test task'
  spec.target = { ...spec.target, name: 'wind turbine', definition: 'onshore wind turbine seen from a drone', target_type: 'object' }
  return spec
}

export function sourceInput(taskId: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    task_id: taskId,
    canonical_url: 'https://example.test/watch?v=abc&utm_source=x',
    platform_item_id: null,
    title: 'wind farm flyover',
    uploader_name: 'someone',
    discovered_via: 'agent_browser',
    query_text: 'wind turbine drone',
    search_run_id: null,
    observed_at: '2026-01-01T00:00:00Z',
    evidence_asset_ids: [],
    platform_id: 'youtube',
    adapter_id: 'agent_browser',
    query_id: null,
    client_discovery_id: 'disc-1',
    media_kind: 'VIDEO',
    ...over,
  }
}
