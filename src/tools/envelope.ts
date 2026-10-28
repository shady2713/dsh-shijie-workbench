import { DomainError } from '../util.ts'

type Dict = Record<string, any>

export const SCHEMA_VERSION = '1.3'

/** The v1.2 Response envelope. Failures are values, so the agent always sees code, status and blockers. */
export function ok(data: unknown, message = 'ok', extra: Dict = {}): Dict {
  return {
    schema_version: SCHEMA_VERSION,
    status: 'OK',
    code: 'OK',
    message,
    job_id: extra.job_id ?? null,
    data,
    artifacts: [],
    retryable: false,
  }
}

export function fail(error: unknown): Dict {
  if (error instanceof DomainError) {
    return {
      schema_version: SCHEMA_VERSION,
      status: error.options.status ?? 'ERROR',
      code: error.code,
      message: error.message,
      job_id: null,
      data: {
        field_errors: error.options.fieldErrors ?? [],
        blockers: error.options.blockers ?? [],
      },
      artifacts: [],
      retryable: error.options.retryable ?? false,
    }
  }
  return {
    schema_version: SCHEMA_VERSION,
    status: 'ERROR',
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    job_id: null,
    data: { field_errors: [], blockers: [] },
    artifacts: [],
    retryable: false,
  }
}

export async function respond(fn: () => unknown | Promise<unknown>, message?: string): Promise<Dict> {
  try {
    return ok(await fn(), message)
  } catch (error) {
    return fail(error)
  }
}
