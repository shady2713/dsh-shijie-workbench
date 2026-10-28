import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

let dir: string | undefined
let fiber: { dispose(): unknown } | undefined

afterEach(async () => {
  await fiber?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
  fiber = undefined
  dir = undefined
})

describe('settings dashboard route', () => {
  it('serves a read-only JSON snapshot and rejects writes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shijie-dashboard-'))
    const ctx = new Context()
    let route: any
    ctx.provide('webServer', {
      register(value: unknown) {
        route = value
        return () => undefined
      },
    })
    ctx.plugin(SystemPrompt)
    ctx.plugin(ToolRuntime)
    ctx.plugin(SkillRegistry)
    fiber = ctx.plugin(plugin, {
      dataDir: dir,
      mode: 'assisted',
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      journal: 'AUTO',
      visionProbe: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(route).toMatchObject({ kind: 'exact', path: '/api/shijie-workbench/status' })

    const get = await callRoute(route.handler, 'GET')
    expect(get.status).toBe(200)
    expect(get.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(get.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(get.body)).toMatchObject({
      schema_version: '1.3',
      database: { file_name: 'workbench.sqlite' },
      totals: { tasks: 0, jobs: 0, media: 0, frames: 0 },
    })

    const post = await callRoute(route.handler, 'POST')
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')
  })
})

async function callRoute(handler: (req: any, res: any) => unknown, method: string) {
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    status: 0,
    writeHead(status: number, values: Record<string, string> = {}) {
      this.status = status
      Object.assign(headers, values)
    },
    end(value?: string) {
      body = value ?? ''
    },
  }
  await handler({ method }, res)
  return { status: res.status, headers, body }
}
