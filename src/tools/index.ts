import { readFileSync } from 'node:fs'
import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parse } from 'yaml'
import { CONTRACTS_DIR } from '../contracts.ts'
import type { Workbench } from '../domain/workbench.ts'
import { respond } from './envelope.ts'

type Args = Record<string, any>

const ACTOR = 'agent'

const str = (description: string) => ({ type: 'string', required: true, description }) as const
const json = (description: string) => ({ type: 'json', required: true, description }) as const

function tool(
  name: string,
  description: string,
  parameters: ParameterSchemaSpec,
  run: (args: Args) => unknown | Promise<unknown>,
  readOnly = false,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schema_version: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['OK', 'ACCEPTED', 'WAITING', 'BLOCKED', 'ERROR'] },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
          job_id: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          data: { type: 'json', required: true },
          artifacts: { type: 'array', items: { type: 'json' }, required: true },
          retryable: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => readOnly,
    execute: async (args) => (await respond(() => run(args as Args))) as never,
  })
}

/**
 * Agent-role operations of contracts/operation_catalog.yaml, and nothing else.
 * Reviewer-only operations (review and capture decisions, policy decisions, task revisions,
 * bootstrap approval, feedback creation, reference import, observation resolution) are deliberately
 * not tools: the agent has no way to record a user decision.
 */
export function createTools(wb: Workbench): ToolDefinition[] {
  return [
    tool('shijie_capabilities', 'Report which workbench capabilities are AVAILABLE, UNCONFIGURED or UNSUPPORTED. Check before relying on ffmpeg, a job executor or host vision.', {}, () => wb.capabilities(), false),

    tool('shijie_contract', 'Return the exact JSON Schema of one v1.3 contract definition (for example TaskSpec, SourceCreate, CaptureAssessmentCreate, JobRequest). Use it before building a request.', {
      name: str('Definition name, e.g. TaskSpec'),
    }, (a) => wb.contracts.def(a.name), true),

    tool('shijie_task_template', 'Return the default draft TaskSpec as JSON. Fill it in; an active task needs target.name and target.definition from the user.', {}, () =>
      parse(readFileSync(new URL('task.template.yaml', CONTRACTS_DIR), 'utf8')), true),

    tool('shijie_task_list', 'List tasks with status and counts.', {}, () => wb.listTasks(), true),

    tool('shijie_task_create', 'Create a task from a TaskSpec (see shijie_task_template). stage "draft" is stored but cannot run; stage "active" needs a defined target. Returns the task detail.', {
      spec: json('TaskSpec object'),
    }, (a) => wb.createTask(a.spec, ACTOR)),

    tool('shijie_task_get', 'Task detail: summary counts, current spec, budgets, blockers, pending feedback, open review batches. Use it to resume a task.', {
      task_id: str('Task id'),
    }, (a) => wb.getTask(a.task_id), true),

    tool('shijie_task_resume', 'Move a BLOCKED or WAITING task back to READY when its blockers are gone. A draft task cannot be resumed.', {
      task_id: str('Task id'),
    }, (a) => wb.resumeTask(a.task_id, ACTOR)),

    tool('shijie_task_close', 'Close a task. Blocked by live jobs, open review batches or unresolved feedback. Without an export it closes as CLOSED_PARTIAL, never as complete.', {
      task_id: str('Task id'),
    }, (a) => wb.closeTask(a.task_id, ACTOR)),

    tool('shijie_task_next', 'Read-only next step for a task: submit a job, wait for the user review, report a blocker, or close. Follow it instead of guessing.', {
      task_id: str('Task id'),
    }, (a) => wb.nextAction(a.task_id), true),

    tool('shijie_source_register', 'Record one discovered work (video or still image) as a source of a task. Deduplicates by platform item id or canonical URL; repeating the same client_discovery_id is idempotent. A registered source is only a lead, not verified.', {
      source: json('SourceCreate object'),
    }, (a) => wb.registerSource(a.source, ACTOR)),

    tool('shijie_source_list', 'List the sources of a task.', {
      task_id: str('Task id'),
    }, (a) => wb.listSources(a.task_id), true),

    tool('shijie_source_get', 'Get one source with its discoveries, media and capture assessments.', {
      source_id: str('Source id'),
    }, (a) => wb.getSource(a.source_id), true),

    tool('shijie_capture_propose', 'Propose a capture-evidence assessment for a source. It is a suggestion; only the user can decide it. VISUAL_ONLY cannot propose SUPPORTED.', {
      assessment: json('CaptureAssessmentCreate object'),
    }, (a) => wb.proposeCapture(a.assessment, ACTOR)),

    tool('shijie_job_submit', 'Queue a job (JobRequest). Local media jobs (media.acquire/probe/overview/sample) can be run with shijie_job_run; other kinds remain queued for later milestones.', {
      job: json('JobRequest object'),
    }, (a) => wb.submitJob(a.job, ACTOR)),

    tool('shijie_job_run', 'Run up to max_jobs queued local media jobs with the M2 executor. It claims work with a lease, records artifacts transactionally and retries retryable failures; an expired claim can never complete.', {
      max_jobs: { type: 'integer', description: 'Number of jobs to run, default 1, max 10' },
    }, (a) => wb.runJobs(Number(a.max_jobs ?? 1))),

    tool('shijie_job_list', 'List jobs, optionally for one task.', {
      task_id: { type: 'string', description: 'Task id; omit for all jobs' },
    }, (a) => wb.listJobs(a.task_id), true),

    tool('shijie_job_get', 'Get one job.', {
      job_id: str('Job id'),
    }, (a) => wb.getJob(a.job_id), true),

    tool('shijie_job_cancel', 'Cancel a job that has not finished.', {
      job_id: str('Job id'),
    }, (a) => wb.cancelJob(a.job_id, ACTOR)),

    // ---- M1.5 agent reads and proposals ----

    tool('shijie_search_plan', 'Read the stored search plan (queries, language, hypothesis, limits) of the task current revision. Empty when no plan job has produced one.', {
      task_id: str('Task id'),
    }, (a) => wb.getSearchPlan(a.task_id), true),

    tool('shijie_source_variants', 'List the format variants of one source with redacted URLs. Use it to choose a route without exposing signatures.', {
      source_id: str('Source id'),
    }, (a) => wb.listSourceVariants(a.source_id), true),

    tool('shijie_source_verify', 'Record the evidence that a source page was actually seen: method, observed URL and at least one evidence asset. This raises the source to PAGE_VERIFIED; it does not approve capture use.', {
      verification: json('SourceVerification object'),
    }, (a) => wb.verifySource(a.verification, ACTOR)),

    tool('shijie_quality_record', 'Record a technical or business quality assessment for a frame at the current task revision. This is a record for review, not a decision.', {
      assessment: json('QualityAssessmentCreate object'),
    }, (a) => wb.recordQualityAssessment(a.assessment, ACTOR)),

    tool('shijie_frame_get', 'Get one frame with its sources, observations, quality assessments, segments, similar frames and effective states. Useful before deciding whether it can be sent to review.', {
      frame_id: str('Frame id'),
      task_id: { type: 'string', description: 'Task id; omit to use the latest observation task' },
    }, (a) => wb.getFrame(a.frame_id, a.task_id), true),

    tool('shijie_frame_list', 'List frames of a task with effective target/viewpoint state and review readiness. Paged by frame_id cursor.', {
      task_id: str('Task id'),
      cursor: { type: 'string', description: 'Last frame_id of the previous page' },
      limit: { type: 'integer', description: 'Page size, default 50, max 200' },
      frame_kind: { type: 'string', enum: ['VIDEO_FRAME', 'STILL_IMAGE'], description: 'Optional frame kind filter' },
    }, (a) => wb.listFrames(a.task_id, { cursor: a.cursor, limit: a.limit, frame_kind: a.frame_kind }), true),

    tool('shijie_coverage_list', 'List what a task actually covered per media: decoded, sampled, delivered or visually reviewed ranges. Do not treat missing rows as no target.', {
      task_id: str('Task id'),
      media_id: { type: 'string', description: 'Optional media id' },
    }, (a) => wb.listCoverage(a.task_id, a.media_id), true),

    tool('shijie_segment_list', 'List the time segments of one media with their evidence mode and observation ids.', {
      media_id: str('Media id'),
    }, (a) => wb.listSegments(a.media_id), true),

    tool('shijie_overlap_list', 'List suggested or confirmed overlaps between media segments of a task.', {
      task_id: str('Task id'),
    }, (a) => wb.listOverlaps(a.task_id), true),

    tool('shijie_policy_request_list', 'List policy requests with their status and decision id. Policy decisions belong to the user; this tool is read-only.', {
      task_id: { type: 'string', description: 'Optional task id' },
    }, (a) => wb.listPolicyRequests(a.task_id), true),

    tool('shijie_policy_rule_list', 'List the standing policy rules approved by the user, with their version and enabled state.', {}, () => wb.listPolicyRules(), true),

    tool('shijie_policy_propose', 'Propose a policy request for one action and scope. It is only a request; the user decides it. Do not claim an approval that does not exist.', {
      request: json('PolicyRequest object'),
    }, (a) => wb.proposePolicy(a.request, ACTOR)),

    tool('shijie_bootstrap_get', 'Read what still needs the user before the workbench is ready: reviewer account, bootstrap approval and active policy rules.', {}, () => wb.getBootstrap(), true),

    tool('shijie_review_batch_list', 'List review batches with candidate, audit-rejected and uncertain counts.', {
      task_id: { type: 'string', description: 'Optional task id' },
    }, (a) => wb.listReviewBatches(a.task_id), true),

    tool('shijie_review_batch_get', 'Read one review batch with its items and effective review ids. Review decisions stay with the user.', {
      batch_id: str('Review batch id'),
    }, (a) => wb.getReviewBatch(a.batch_id), true),

    tool('shijie_export_get', 'Read one export manifest record. annotation_complete and dataset_ready are always false; an export is not an annotation dataset.', {
      export_id: str('Export id'),
    }, (a) => wb.getExport(a.export_id), true),

    tool('shijie_feedback_list', 'List user feedback on a task and the jobs created from it.', {
      task_id: str('Task id'),
    }, (a) => wb.listFeedback(a.task_id), true),

    tool('shijie_evidence_import', 'Import a local browser capture, license snapshot or source metadata file into the artifact store. The path must be relative to the workbench data directory.', {
      evidence: json('EvidenceImport object'),
    }, (a) => wb.importEvidence(a.evidence, ACTOR)),
  ]
}
