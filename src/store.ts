import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { CONTRACTS_DIR, CONTRACT_VERSION } from './contracts.ts'
import { newId, nowIso, DomainError } from './util.ts'

/**
 * SQLite WAL-reset corruption was fixed in 3.51.3 and backported to 3.50.7 and 3.44.6.
 * Anything else stays on the DELETE journal (docs/05 and scripts/doctor.py in the v1.2 package).
 */
export function walFixVerified(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return false
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (major !== 3) return major > 3
  if (minor === 44) return patch >= 6
  if (minor === 50) return patch >= 7
  if (minor >= 52) return true
  if (minor === 51) return patch >= 3
  return false
}

export interface StoreOptions {
  /** ':memory:' or a file path. */
  path: string
  journal?: 'AUTO' | 'DELETE' | 'WAL'
}

export type Row = Record<string, SQLInputValue | null | bigint | Uint8Array>

export class Store {
  readonly db: DatabaseSync
  readonly sqliteVersion: string
  readonly journalMode: string

  constructor(options: StoreOptions) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true })
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.sqliteVersion = String((this.db.prepare('select sqlite_version() as v').get() as { v: string }).v)

    const wantWal = options.journal === 'WAL' || (options.journal === 'AUTO' && walFixVerified(this.sqliteVersion))
    if (options.journal === 'WAL' && !walFixVerified(this.sqliteVersion)) {
      throw new DomainError('CAPABILITY_MISSING', `WAL requested but SQLite ${this.sqliteVersion} has no verified WAL-reset fix`)
    }
    if (options.path !== ':memory:') {
      this.db.exec(`PRAGMA journal_mode = ${wantWal ? 'WAL' : 'DELETE'}`)
    }
    this.journalMode = String((this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)
    this.migrate()
  }

  /** Fresh databases get the current DDL; existing databases get one explicit migration step. */
  private migrate(): void {
    const exists = this.db
      .prepare("select 1 as x from sqlite_master where type='table' and name='schema_migrations'")
      .get()
    if (!exists) {
      const ddl = readFileSync(new URL('schema.sql', CONTRACTS_DIR), 'utf8')
      this.db.exec('BEGIN')
      try {
        this.db.exec(ddl)
        this.db.prepare('insert into schema_migrations(version, applied_at) values (?, ?)').run(CONTRACT_VERSION, nowIso())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return
    }

    const current = this.db.prepare('select max(version) as version from schema_migrations').get() as { version: string | null }
    if (current.version === CONTRACT_VERSION) return
    if (!current.version) {
      throw new DomainError('CAPABILITY_MISSING', `database schema has no recorded version; expected ${CONTRACT_VERSION}`)
    }

    let migration: string
    try {
      migration = readFileSync(new URL(`migrations/${current.version}-to-${CONTRACT_VERSION}.sql`, CONTRACTS_DIR), 'utf8')
    } catch {
      throw new DomainError(
        'CAPABILITY_MISSING',
        `database schema is ${current.version}; no migration to ${CONTRACT_VERSION} is provided`,
      )
    }
    this.db.exec('BEGIN')
    try {
      this.db.exec(migration)
      this.db.prepare('insert into schema_migrations(version, applied_at) values (?, ?)').run(CONTRACT_VERSION, nowIso())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params)
  }

  /** One short serial transaction. Domain events commit in the same transaction as the change. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  audit(actorId: string, eventType: string, entityType: string, entityId: string, event: unknown): string {
    const eventId = newId('evt')
    this.run(
      'insert into audit_events(event_id, actor_id, event_type, entity_type, entity_id, event_json, created_at) values (?,?,?,?,?,?,?)',
      eventId,
      actorId,
      eventType,
      entityType,
      entityId,
      JSON.stringify(event ?? {}),
      nowIso(),
    )
    return eventId
  }

  close(): void {
    this.db.close()
  }
}

/** Foreign-key and CHECK failures from the DDL become domain errors instead of raw SQLite text. */
export function mapConstraint(error: unknown, code = 'REFERENCE_NOT_FOUND'): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/FOREIGN KEY constraint failed/i.test(message)) throw new DomainError(code, 'a referenced entity does not exist')
  if (/CHECK constraint failed|NOT NULL constraint failed/i.test(message)) {
    throw new DomainError('SCHEMA_INVALID', `database rejected the value: ${message}`)
  }
  throw error
}
