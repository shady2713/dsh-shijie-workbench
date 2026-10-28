import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store.ts'
import { DomainError, nowIso, sha256Hex } from '../util.ts'

export interface ClaimedJob {
  job_id: string
  task_id: string | null
  task_revision: number | null
  kind: string
  request: Record<string, any>
  attempt: number
  max_attempts: number
  claim_generation: number
  worker_id: string
  lease_token: string
  lease_expires_at: string
}

export interface ArtifactDraft {
  artifact_id: string
  kind: string
  relative_path: string
  sha256: string
  bytes: number
  mime_type: string
  metadata: unknown
  synthetic?: boolean
}

export interface CompletionInput {
  result: unknown
  artifacts?: ArtifactDraft[]
  completion_scope?: 'FULL' | 'PARTIAL'
  unprocessed_inputs?: unknown[]
  /** Domain rows that must commit in the same transaction as the completion event. */
  apply?: (artifacts: ArtifactDraft[]) => void
}

export interface FailureOutcome {
  status: 'QUEUED' | 'FAILED' | 'IGNORED'
  error_code: string
  retryable: boolean
}

/**
 * Persistent SQLite job claim/lease executor.
 *
 * The queue is the jobs table; a claim is a short lease plus a monotonic
 * claim_generation. A worker that lost its lease can never commit because both
 * the token hash and the generation are checked again inside the completion
 * transaction.
 */
export class JobExecutor {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  claimNext(workerId: string, leaseMs: number, kinds: string[]): ClaimedJob | null {
    if (kinds.length === 0) return null
    const now = nowIso()
    return this.store.tx(() => {
      const placeholders = kinds.map(() => '?').join(',')
      const row = this.store.get<Record<string, any>>(
        `select * from jobs
         where (status='QUEUED' or (status='RUNNING' and (lease_expires_at is null or lease_expires_at<=?)))
           and kind in (${placeholders})
         order by created_at, job_id limit 1`,
        now,
        ...kinds,
      )
      if (!row) return null
      const token = randomBytes(32).toString('hex')
      const attempt = Number(row.attempt) + 1
      const expires = new Date(Date.now() + leaseMs).toISOString()
      const generation = Number(row.claim_generation) + 1
      this.store.run(
        `update jobs set status='RUNNING', attempt=?, worker_id=?, lease_token_sha256=?,
           lease_expires_at=?, heartbeat_at=?, claim_generation=?, updated_at=?
         where job_id=?`,
        attempt,
        workerId,
        sha256Hex(token),
        expires,
        now,
        generation,
        now,
        String(row.job_id),
      )
      return {
        job_id: String(row.job_id),
        task_id: row.task_id === null ? null : String(row.task_id),
        task_revision: row.task_revision === null ? null : Number(row.task_revision),
        kind: String(row.kind),
        request: JSON.parse(String(row.request_json)) as Record<string, any>,
        attempt,
        max_attempts: Number(row.max_attempts),
        claim_generation: generation,
        worker_id: workerId,
        lease_token: token,
        lease_expires_at: expires,
      }
    })
  }

  heartbeat(claim: ClaimedJob, leaseMs: number): string {
    const now = nowIso()
    const expires = new Date(Date.now() + leaseMs).toISOString()
    const result = this.store.db
      .prepare(
        `update jobs set heartbeat_at=?, lease_expires_at=?, updated_at=?
         where job_id=? and status='RUNNING' and worker_id=? and claim_generation=?
           and lease_token_sha256=? and lease_expires_at>?`,
      )
      .run(
        now,
        expires,
        now,
        claim.job_id,
        claim.worker_id,
        claim.claim_generation,
        sha256Hex(claim.lease_token),
        now,
      )
    if (Number(result.changes) !== 1) {
      throw new DomainError('CLAIM_EXPIRED', 'the job lease is no longer held by this claim')
    }
    claim.lease_expires_at = expires
    return expires
  }

  complete(claim: ClaimedJob, input: CompletionInput): { job_id: string; already_completed: boolean; artifact_ids: string[] } {
    return this.store.tx(() => {
      const row = this.store.get<Record<string, any>>('select * from jobs where job_id=?', claim.job_id)
      if (!row) throw new DomainError('REFERENCE_NOT_FOUND', `job ${claim.job_id} does not exist`)
      if (String(row.status) === 'SUCCEEDED') {
        const ids = this.store
          .all<{ artifact_id: string }>('select artifact_id from artifacts where job_id=? order by created_at', claim.job_id)
          .map((r) => r.artifact_id)
        return { job_id: claim.job_id, already_completed: true, artifact_ids: ids }
      }
      this.assertClaimInTransaction(claim)

      const artifacts = input.artifacts ?? []
      for (const artifact of artifacts) this.insertOrVerifyArtifact(claim, artifact)
      input.apply?.(artifacts)

      const now = nowIso()
      const changes = this.store.db
        .prepare(
          `update jobs set status='SUCCEEDED', completion_scope=?, unprocessed_inputs_json=?,
             result_json=?, error_code=NULL, lease_expires_at=NULL, heartbeat_at=?, updated_at=?
           where job_id=? and status='RUNNING' and worker_id=? and claim_generation=?
             and lease_token_sha256=? and lease_expires_at>?`,
        )
        .run(
          input.completion_scope ?? 'FULL',
          JSON.stringify(input.unprocessed_inputs ?? []),
          JSON.stringify(input.result ?? {}),
          now,
          now,
          claim.job_id,
          claim.worker_id,
          claim.claim_generation,
          sha256Hex(claim.lease_token),
          now,
        )
      if (Number(changes.changes) !== 1) {
        throw new DomainError('CLAIM_EXPIRED', 'the job claim expired before completion could commit')
      }

      this.insertWorkflowEvent(claim, 'job.completed', `${claim.job_id}:completion`, {
        job_id: claim.job_id,
        kind: claim.kind,
        artifact_ids: artifacts.map((a) => a.artifact_id),
        completion_scope: input.completion_scope ?? 'FULL',
      }, now)
      this.store.audit('executor', 'job.completed', 'job', claim.job_id, {
        kind: claim.kind,
        attempt: claim.attempt,
        claim_generation: claim.claim_generation,
      })
      return { job_id: claim.job_id, already_completed: false, artifact_ids: artifacts.map((a) => a.artifact_id) }
    })
  }

  fail(claim: ClaimedJob, error: unknown): FailureOutcome {
    const domainError = error instanceof DomainError ? error : new DomainError('INTERNAL', error instanceof Error ? error.message : String(error))
    return this.store.tx(() => {
      const row = this.store.get<Record<string, any>>('select * from jobs where job_id=?', claim.job_id)
      if (!row) return { status: 'IGNORED' as const, error_code: domainError.code, retryable: false }
      if (String(row.status) === 'SUCCEEDED' || String(row.status) === 'CANCELLED') {
        return { status: 'IGNORED' as const, error_code: domainError.code, retryable: false }
      }
      if (
        String(row.status) !== 'RUNNING' ||
        Number(row.claim_generation) !== claim.claim_generation ||
        String(row.lease_token_sha256) !== sha256Hex(claim.lease_token) ||
        String(row.lease_expires_at ?? '') <= nowIso()
      ) {
        return { status: 'IGNORED' as const, error_code: 'CLAIM_EXPIRED', retryable: true }
      }

      const retryable = domainError.options.retryable !== false
      const canRetry = retryable && Number(row.attempt) < Number(row.max_attempts)
      const status = canRetry ? 'QUEUED' : 'FAILED'
      const now = nowIso()
      this.store.run(
        `update jobs set status=?, worker_id=NULL, lease_token_sha256=NULL, lease_expires_at=NULL,
           heartbeat_at=NULL, error_code=?, updated_at=? where job_id=?`,
        status,
        domainError.code,
        now,
        claim.job_id,
      )
      this.insertWorkflowEvent(
        claim,
        canRetry ? 'job.retry_scheduled' : 'job.failed',
        `${claim.job_id}:attempt:${claim.attempt}:${canRetry ? 'retry' : 'failed'}`,
        { job_id: claim.job_id, kind: claim.kind, attempt: claim.attempt, error_code: domainError.code, retryable },
        now,
      )
      this.store.audit('executor', canRetry ? 'job.retry_scheduled' : 'job.failed', 'job', claim.job_id, {
        attempt: claim.attempt,
        error_code: domainError.code,
        message: domainError.message,
      })
      return { status, error_code: domainError.code, retryable }
    })
  }

  private assertClaimInTransaction(claim: ClaimedJob): void {
    const row = this.store.get<Record<string, any>>('select * from jobs where job_id=?', claim.job_id)
    if (!row) throw new DomainError('REFERENCE_NOT_FOUND', `job ${claim.job_id} does not exist`)
    if (String(row.status) !== 'RUNNING') {
      throw new DomainError('INVALID_STATE', `job ${claim.job_id} is ${String(row.status)}, not RUNNING`)
    }
    if (
      Number(row.claim_generation) !== claim.claim_generation ||
      String(row.worker_id ?? '') !== claim.worker_id ||
      String(row.lease_token_sha256 ?? '') !== sha256Hex(claim.lease_token) ||
      String(row.lease_expires_at ?? '') <= nowIso()
    ) {
      throw new DomainError('CLAIM_EXPIRED', 'the job claim is stale; refusing to commit')
    }
  }

  private insertOrVerifyArtifact(claim: ClaimedJob, artifact: ArtifactDraft): void {
    const absolute = join(this.dataDir, artifact.relative_path)
    if (!existsSync(absolute)) {
      throw new DomainError('ARTIFACT_MISSING', `artifact file does not exist: ${artifact.relative_path}`)
    }
    const stat = statSync(absolute)
    const actualSha = sha256Hex(readFileSync(absolute))
    if (!stat.isFile() || stat.size !== artifact.bytes || actualSha !== artifact.sha256) {
      throw new DomainError('ARTIFACT_HASH_MISMATCH', `artifact bytes changed before commit: ${artifact.relative_path}`)
    }
    const existing = this.store.get<Record<string, any>>('select * from artifacts where artifact_id=?', artifact.artifact_id)
    if (existing) {
      if (
        String(existing.sha256) !== artifact.sha256 ||
        Number(existing.bytes) !== artifact.bytes ||
        String(existing.relative_path) !== artifact.relative_path
      ) {
        throw new DomainError('ARTIFACT_CONFLICT', `artifact ${artifact.artifact_id} already exists with different content`)
      }
      return
    }
    this.store.run(
      `insert into artifacts(artifact_id,job_id,kind,relative_path,sha256,bytes,mime_type,metadata_json,synthetic,created_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      artifact.artifact_id,
      claim.job_id,
      artifact.kind,
      artifact.relative_path,
      artifact.sha256,
      artifact.bytes,
      artifact.mime_type,
      JSON.stringify(artifact.metadata ?? {}),
      artifact.synthetic ? 1 : 0,
      nowIso(),
    )
  }

  private insertWorkflowEvent(claim: ClaimedJob, eventType: string, idempotencyKey: string, payload: unknown, now: string): void {
    if (!claim.task_id) return
    this.store.run(
      `insert or ignore into workflow_events(event_id,task_id,parent_job_id,event_type,payload_json,idempotency_key,dispatch_state,created_at)
       values (?,?,?,?,?,?,?,?)`,
      `evt_${sha256Hex(idempotencyKey).slice(0, 20)}`,
      claim.task_id,
      claim.job_id,
      eventType,
      JSON.stringify(payload ?? {}),
      idempotencyKey,
      'PENDING',
      now,
    )
  }
}
