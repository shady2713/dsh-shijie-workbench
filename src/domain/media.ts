import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { DomainError } from '../util.ts'

const execFileAsync = promisify(execFile)

export interface VideoStreamInfo {
  index: number
  codec_name: string | null
  width: number
  height: number
  time_base: string
  start_time_s: number | null
  duration_s: number | null
  r_frame_rate: string
  avg_frame_rate: string
  nb_frames: number | null
}

export interface MediaProbe {
  format_name: string
  duration_s: number
  start_time_s: number
  nonzero_start: boolean
  video_streams: VideoStreamInfo[]
  primary: VideoStreamInfo
  cfr: boolean
  vfr: boolean
  pts_monotonic: boolean
  pts_regular: boolean
  sampled_frame_count: number
  probe_version: string
}

export interface AnalysisFrame {
  index: number
  time_s: number
  gray: Uint8Array
  width: number
  height: number
  blur_variance: number
  scene_cut_score: number
}

export interface AnalysisResult {
  fps: number
  frames: AnalysisFrame[]
  scene_cuts: { time_s: number; score: number }[]
  duration_s: number
  start_time_s: number
}

export interface SamplingOptions {
  change_threshold: number
  min_frame_interval_s: number
  max_frame_interval_s: number
  scene_cut_threshold: number
  max_candidate_frames: number
}

export interface SelectedFrame {
  index: number
  time_s: number
  change_score: number
  scene_cut_score: number
  trigger: 'FIRST_FRAME' | 'CHANGE_THRESHOLD' | 'SCENE_CUT' | 'MAX_INTERVAL' | 'FIXED_INTERVAL'
  blur_variance: number
}

export interface SelectionResult {
  selected: SelectedFrame[]
  truncated: boolean
}

const ANALYSIS_WIDTH = 64
const ANALYSIS_HEIGHT = 64
const ANALYSIS_FPS = 5
const FRAME_BYTES = ANALYSIS_WIDTH * ANALYSIS_HEIGHT

function ratio(text: string | undefined): number {
  if (!text) return 0
  const parts = text.split('/').map(Number)
  const a = parts[0]
  const b = parts[1]
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0
  return a / b
}

function numberOrNull(text: unknown): number | null {
  if (text === null || text === undefined || text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** ffprobe metadata: duration, streams, PTS regularity, CFR/VFR and non-zero start. */
export async function probeMedia(ffprobePath: string, filePath: string): Promise<MediaProbe> {
  let metadata: any
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 30_000, windowsHide: true },
    )
    metadata = JSON.parse(stdout)
  } catch (error) {
    throw new DomainError('MEDIA_PROBE_FAILED', `ffprobe failed: ${(error as Error).message.split('\n')[0]}`)
  }

  const streams = Array.isArray(metadata.streams) ? metadata.streams : []
  const videoStreams: VideoStreamInfo[] = streams
    .filter((s: any) => s.codec_type === 'video')
    .map((s: any) => ({
      index: Number(s.index ?? 0),
      codec_name: s.codec_name ?? null,
      width: Number(s.width ?? 0),
      height: Number(s.height ?? 0),
      time_base: String(s.time_base ?? '1/1000'),
      start_time_s: numberOrNull(s.start_time),
      duration_s: numberOrNull(s.duration),
      r_frame_rate: String(s.r_frame_rate ?? '0/0'),
      avg_frame_rate: String(s.avg_frame_rate ?? '0/0'),
      nb_frames: numberOrNull(s.nb_frames),
    }))
  if (videoStreams.length === 0) {
    throw new DomainError('MEDIA_PROBE_FAILED', 'the file has no video stream')
  }
  const primary = videoStreams[0]!
  const format = metadata.format ?? {}
  const formatStart = numberOrNull(format.start_time)
  const streamStart = primary.start_time_s
  const startTimeS = formatStart ?? streamStart ?? 0
  const duration = numberOrNull(format.duration) ?? primary.duration_s ?? 0

  let frameTimes: number[] = []
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+10',
        '-show_frames', '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
        '-print_format', 'json', filePath,
      ],
      { timeout: 30_000, windowsHide: true },
    )
    const parsed = JSON.parse(stdout)
    frameTimes = (Array.isArray(parsed.frames) ? parsed.frames : [])
      .map((f: any) => numberOrNull(f.pts_time) ?? numberOrNull(f.best_effort_timestamp_time))
      .filter((n: number | null): n is number => n !== null)
  } catch {
    frameTimes = []
  }

  const deltas: number[] = []
  for (let i = 1; i < frameTimes.length; i += 1) deltas.push(frameTimes[i]! - frameTimes[i - 1]!)
  const positive = deltas.filter((d) => d > 0)
  const median = positive.length > 0 ? [...positive].sort((a, b) => a - b)[Math.floor(positive.length / 2)]! : 0
  const ptsMonotonic = deltas.length === 0 || deltas.every((d) => d > 0)
  const ptsRegular = positive.length === 0 || positive.every((d) => Math.abs(d - median) <= median * 0.02)
  const rRate = ratio(primary.r_frame_rate)
  const avgRate = ratio(primary.avg_frame_rate)
  const rateDiff = rRate > 0 && avgRate > 0 ? Math.abs(rRate - avgRate) / Math.max(rRate, avgRate) : 0
  const vfr = (rRate > 0 && avgRate > 0 && rateDiff > 0.001) || (positive.length > 2 && !ptsRegular)
  const cfr = !vfr && ptsRegular

  return {
    format_name: String(format.format_name ?? ''),
    duration_s: Math.max(0, duration),
    start_time_s: startTimeS,
    nonzero_start: Math.abs(startTimeS) > 0.0005,
    video_streams: videoStreams,
    primary,
    cfr,
    vfr,
    pts_monotonic: ptsMonotonic,
    pts_regular: ptsRegular,
    sampled_frame_count: frameTimes.length,
    probe_version: 'ffprobe-json-v1',
  }
}

function blurVariance(gray: Uint8Array, width: number, height: number): number {
  const values: number[] = []
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (xx: number, yy: number): number => gray[yy * width + xx] ?? 0
      const laplacian =
        -at(x - 1, y - 1) - at(x, y - 1) - at(x + 1, y - 1) -
        at(x - 1, y) + 8 * at(x, y) - at(x + 1, y) -
        at(x - 1, y + 1) - at(x, y + 1) - at(x + 1, y + 1)
      values.push(laplacian)
    }
  }
  if (values.length === 0) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
}

function meanDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  return total / (a.length * 255)
}

function parseScdet(text: string): Map<number, number> {
  const scores = new Map<number, number>()
  let currentTime: number | null = null
  for (const line of text.split(/\r?\n/)) {
    const frame = /^frame:\d+\s+pts:\d+\s+pts_time:([0-9.]+)/.exec(line)
    if (frame) {
      currentTime = Number(frame[1])
      continue
    }
    const score = /^lavfi\.scd\.score=([0-9.]+)/.exec(line)
    if (score && currentTime !== null) scores.set(currentTime, Number(score[1]) / 100)
  }
  return scores
}

/** Decode at 5 fps into 64x64 gray frames and run ffmpeg scdet on the same source. */
export async function analyzeVideo(ffmpegPath: string, filePath: string, tempDir: string, startTimeS = 0): Promise<AnalysisResult> {
  mkdirSync(tempDir, { recursive: true })
  const rawPath = join(tempDir, 'analysis-gray.raw')
  const scdetPath = join(tempDir, 'scdet.txt')
  try {
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-i', filePath,
        '-vf', `fps=${ANALYSIS_FPS},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT},format=gray`,
        '-f', 'rawvideo', '-y', rawPath,
      ],
      { timeout: 300_000, windowsHide: true },
    )
    try {
      await execFileAsync(
        ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-vf', 'scdet=threshold=0,metadata=print:file=scdet.txt', '-f', 'null', '-'],
        { timeout: 300_000, windowsHide: true, cwd: tempDir },
      )
    } catch {
      writeFileSync(scdetPath, '')
    }
  } catch (error) {
    throw new DomainError('MEDIA_DECODE_FAILED', `ffmpeg decode failed: ${(error as Error).message.split('\n')[0]}`)
  }

  const raw = readFileSync(rawPath)
  const frameCount = Math.floor(raw.length / FRAME_BYTES)
  let sceneScores = new Map<number, number>()
  try {
    sceneScores = parseScdet(readFileSync(scdetPath, 'utf8'))
  } catch {
    sceneScores = new Map()
  }

  const frames: AnalysisFrame[] = []
  const sceneCuts: { time_s: number; score: number }[] = []
  for (let i = 0; i < frameCount; i += 1) {
    const gray = raw.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)
    const timeS = startTimeS + i / ANALYSIS_FPS
    let score = 0
    for (const [t, s] of sceneScores) {
      if (t >= timeS - 1 / ANALYSIS_FPS - 0.0001 && t <= timeS + 0.0001) score = Math.max(score, s)
    }
    if (score > 0) sceneCuts.push({ time_s: timeS, score })
    frames.push({
      index: i,
      time_s: timeS,
      gray: Uint8Array.from(gray),
      width: ANALYSIS_WIDTH,
      height: ANALYSIS_HEIGHT,
      blur_variance: blurVariance(gray, ANALYSIS_WIDTH, ANALYSIS_HEIGHT),
      scene_cut_score: score,
    })
  }
  return { fps: ANALYSIS_FPS, frames, scene_cuts: sceneCuts, duration_s: frameCount / ANALYSIS_FPS, start_time_s: startTimeS }
}

/**
 * v1.3 change-based selection: cumulative visual change since the last kept
 * frame, bounded by minimum and maximum intervals. A scene cut is kept even
 * when the minimum interval has not elapsed.
 */
export function selectChangeFrames(analysis: AnalysisResult, options: SamplingOptions): SelectionResult {
  const frames = analysis.frames
  if (frames.length === 0) return { selected: [], truncated: false }
  const maxFrames = Math.max(1, options.max_candidate_frames)
  const minInterval = Math.max(0, options.min_frame_interval_s)
  const maxInterval = Math.max(minInterval, options.max_frame_interval_s)
  const selected: SelectedFrame[] = []
  let lastKept = frames[0]!
  selected.push({
    index: lastKept.index,
    time_s: lastKept.time_s,
    change_score: 0,
    scene_cut_score: lastKept.scene_cut_score,
    trigger: 'FIRST_FRAME',
    blur_variance: lastKept.blur_variance,
  })
  let truncated = false
  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i]!
    if (selected.length >= maxFrames) {
      truncated = true
      break
    }
    const elapsed = frame.time_s - lastKept.time_s
    const changeScore = meanDiff(lastKept.gray, frame.gray)
    const sceneCut = frame.scene_cut_score >= options.scene_cut_threshold
    let trigger: SelectedFrame['trigger'] | null = null
    if (sceneCut) trigger = 'SCENE_CUT'
    else if (changeScore >= options.change_threshold && elapsed >= minInterval) trigger = 'CHANGE_THRESHOLD'
    else if (elapsed >= maxInterval) trigger = 'MAX_INTERVAL'
    if (!trigger) continue
    selected.push({
      index: frame.index,
      time_s: frame.time_s,
      change_score: Number(changeScore.toFixed(6)),
      scene_cut_score: Number(frame.scene_cut_score.toFixed(6)),
      trigger,
      blur_variance: Number(frame.blur_variance.toFixed(3)),
    })
    lastKept = frame
  }
  return { selected, truncated }
}

/** v1.2 compatibility fallback: keep the first frame and then every interval. */
export function selectFixedFrames(analysis: AnalysisResult, intervalS: number, maxFrames: number): SelectionResult {
  const frames = analysis.frames
  if (frames.length === 0) return { selected: [], truncated: false }
  const interval = Math.max(0.05, intervalS)
  const selected: SelectedFrame[] = []
  let nextTime = frames[0]!.time_s
  let truncated = false
  for (const frame of frames) {
    if (selected.length >= maxFrames) {
      truncated = true
      break
    }
    if (frame.time_s + 0.0001 >= nextTime) {
      selected.push({
        index: frame.index,
        time_s: frame.time_s,
        change_score: 0,
        scene_cut_score: frame.scene_cut_score,
        trigger: selected.length === 0 ? 'FIRST_FRAME' : 'FIXED_INTERVAL',
        blur_variance: Number(frame.blur_variance.toFixed(3)),
      })
      nextTime = frame.time_s + interval
    }
  }
  return { selected, truncated }
}

export async function extractFrame(
  ffmpegPath: string,
  filePath: string,
  timeS: number,
  outputPath: string,
): Promise<void> {
  mkdirSync(join(outputPath, '..'), { recursive: true })
  try {
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-ss', timeS.toFixed(3), '-frames:v', '1', '-y', outputPath],
      { timeout: 120_000, windowsHide: true },
    )
  } catch (error) {
    throw new DomainError('MEDIA_DECODE_FAILED', `ffmpeg frame extraction failed at ${timeS}s: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!readFileSync(outputPath).length) throw new DomainError('MEDIA_DECODE_FAILED', `ffmpeg produced an empty frame at ${timeS}s`)
}

export function removeTempDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best effort; the next retry uses the same deterministic path.
  }
}

export function extensionOf(path: string): string {
  return extname(path).toLowerCase()
}

export function baseNameOf(path: string): string {
  return basename(path)
}
