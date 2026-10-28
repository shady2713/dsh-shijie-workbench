import { createHash, randomUUID } from 'node:crypto'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      status?: 'ERROR' | 'BLOCKED' | 'WAITING'
      retryable?: boolean
      fieldErrors?: { field: string; message: string }[]
      blockers?: { code: string; entity_id: string; missing: string; retryable: boolean }[]
    } = {},
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export const nowIso = (): string => new Date().toISOString()

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** Stable serialization: object keys sorted recursively so equal specs hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Tracking parameters never identify a work; dropping them keeps duplicate sources from splitting. */
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|igshid|spm|share_source|from|feature)$/i

export function canonicalUrlKey(raw: string): string {
  const url = new URL(raw)
  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  let path = url.pathname
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  url.pathname = path
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`
}
