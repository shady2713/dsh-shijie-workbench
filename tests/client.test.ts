import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('settings dashboard client', () => {
  it('registers the settings section without touching the host DOM before apply', () => {
    let loaded: any
    const style = { dataset: {} as Record<string, string>, textContent: '' }
    const document = {
      createElement: () => style,
      head: { appendChild: () => undefined },
    }
    const window = {
      __ModuleLoader__: {
        load: (entry: any) => {
          loaded = {
            ...entry,
            module: entry.factory((name: string) => {
              if (name !== 'react') throw new Error(`unexpected require: ${name}`)
              return {
                createElement: () => null,
                useState: () => [null, () => undefined],
                useEffect: () => undefined,
                useCallback: (fn: unknown) => fn,
              }
            }),
          }
        },
      },
    }
    const context = {
      window,
      document,
      fetch: async () => ({ ok: false, status: 503 }),
      setInterval: () => 0,
      clearInterval: () => undefined,
      console,
    }
    runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context)

    expect(loaded.id).toBe('dsh-shijie-workbench')
    expect(loaded.module.inject).toEqual(['slots'])

    let registration: any
    const ctx = {
      effect: (fn: () => () => void) => fn(),
      slots: {
        inject: (name: string, callback: () => unknown) => callback(),
        register: (options: unknown, component: unknown) => {
          registration = { options, component }
          return () => undefined
        },
      },
    }
    loaded.module.apply(ctx)
    expect(registration.options).toMatchObject({
      name: 'settings.section',
      id: 'shijie-workbench',
      order: 95,
    })
    expect(registration.options.label()).toBe('视界工作台')
    expect(typeof registration.component).toBe('function')
  })
})
