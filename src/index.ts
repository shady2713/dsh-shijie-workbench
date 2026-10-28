import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { loadContracts } from './contracts.ts'
import { Workbench } from './domain/workbench.ts'
import { Store } from './store.ts'
import { createTools } from './tools/index.ts'
import { createVisionTools, type VisionAttachments } from './vision.ts'

export const name = 'shijie-workbench'
export const inject = ['tools', 'skills']
export { Config }

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const SKILL_URL = new URL('../skills/shijie-workbench/SKILL.md', import.meta.url)

/** Frontmatter is routing metadata for file-based loaders; the registry takes it from the registration instead. */
function skillBody(): string {
  const text = readFileSync(SKILL_URL, 'utf8')
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

export function apply(ctx: Context, config: Config): void {
  const store = new Store({ path: join(config.dataDir, 'workbench.sqlite'), journal: config.journal })
  ctx.effect(() => () => store.close())

  const workbench = new Workbench({
    store,
    contracts: loadContracts(),
    mode: config.mode,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    dataDir: config.dataDir,
    evidenceMaxBytes: config.evidenceMaxBytes,
    visionProbe: config.visionProbe !== false,
  })

  for (const definition of createTools(workbench)) ctx.tools.register(definition)

  // The settings page is a read-only view. Keep it on an exact local route so
  // the client never needs write access to the SQLite database.
  ctx.inject(['webServer'], (scope) => {
    const webServer = (scope as unknown as { webServer: WebServerLike }).webServer
    webServer.register({
      kind: 'exact',
      path: '/api/shijie-workbench/status',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        try {
          const body = JSON.stringify(workbench.dashboard())
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          if (req.method === 'HEAD') res.end()
          else res.end(body)
        } catch {
          res.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          res.end(JSON.stringify({ status: 'ERROR', code: 'DASHBOARD_UNAVAILABLE' }))
        }
      },
    })
  })

  if (config.visionProbe !== false) {
    // The attachments service is optional for business tools; the E1 probe only
    // loads when the host provides image attachment storage.
    ctx.inject(['attachments'], (scope) => {
      const getAttachments = () => (scope as unknown as { attachments?: VisionAttachments }).attachments
      for (const definition of createVisionTools(getAttachments)) scope.tools.register(definition)
    })
  }

  ctx.skills.register({
    name: 'shijie-workbench',
    description: 'Run the Shijie aerial footage and photo sourcing workbench: tasks, sources, capture evidence, jobs, and the review boundary.',
    whenToUse: 'Use when searching the internet for real drone footage or aerial photos for a target object, or when resuming such a task.',
    source: 'runtime',
    content: skillBody(),
  })
}
