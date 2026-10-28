import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { DomainError } from './util.ts'

export const CONTRACTS_DIR = new URL('../contracts/', import.meta.url)

export const CONTRACT_VERSION = '1.3'

export interface Contracts {
  /** Validate `data` against `#/$defs/<def>` of the shared v1.3 schema file; throws SCHEMA_INVALID. */
  assert<T>(def: string, data: unknown): T
  /** Names of every definition. */
  defs(): string[]
  /** The raw JSON Schema of one definition, for agents that need the exact shape. */
  def(name: string): unknown
}

export function loadContracts(): Contracts {
  const raw = JSON.parse(readFileSync(new URL('schemas.json', CONTRACTS_DIR), 'utf8')) as {
    $id: string
    $defs: Record<string, unknown>
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats.default(ajv)
  ajv.addSchema(raw)
  const cache = new Map<string, ReturnType<Ajv2020['getSchema']>>()

  return {
    assert<T>(def: string, data: unknown): T {
      let validate = cache.get(def)
      if (!validate) {
        validate = ajv.getSchema(`${raw.$id}#/$defs/${def}`)
        if (!validate) throw new Error(`contract definition not found: ${def}`)
        cache.set(def, validate)
      }
      if (!validate(data)) {
        const fieldErrors = (validate.errors ?? []).slice(0, 20).map((e) => ({
          field: e.instancePath || '/',
          message: e.message ?? 'invalid',
        }))
        throw new DomainError('SCHEMA_INVALID', `${def} failed validation`, { fieldErrors })
      }
      return data as T
    },
    defs: () => Object.keys(raw.$defs),
    def(name: string): unknown {
      if (!Object.hasOwn(raw.$defs, name)) throw new DomainError('NOT_FOUND', `unknown contract definition: ${name}`)
      return raw.$defs[name]
    },
  }
}
