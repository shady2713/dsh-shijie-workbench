import { describe, expect, it } from 'vitest'
import { selectChangeFrames, selectFixedFrames, type AnalysisFrame, type AnalysisResult } from '../src/domain/media.ts'

const W = 64
const H = 64
const FPS = 5

function frame(index: number, value: number, sceneCutScore = 0): AnalysisFrame {
  return {
    index,
    time_s: index / FPS,
    gray: new Uint8Array(W * H).fill(value),
    width: W,
    height: H,
    blur_variance: 0,
    scene_cut_score: sceneCutScore,
  }
}

function analysis(values: number[], sceneCutScores: Record<number, number> = {}): AnalysisResult {
  const frames = values.map((value, index) => frame(index, value, sceneCutScores[index] ?? 0))
  return { fps: FPS, frames, scene_cuts: [], duration_s: frames.length / FPS, start_time_s: 0 }
}

const base = {
  change_threshold: 0.35,
  min_frame_interval_s: 0.5,
  max_frame_interval_s: 10,
  scene_cut_threshold: 0.3,
  max_candidate_frames: 100,
}

describe('change-based frame selection', () => {
  it('honours the minimum interval before a change can be kept', () => {
    const values = [0, 255, 255, 255, 255, 255]
    const result = selectChangeFrames(analysis(values), base)
    expect(result.selected.map((s) => s.trigger)).toEqual(['FIRST_FRAME', 'CHANGE_THRESHOLD'])
    expect(result.selected[1]!.time_s).toBeCloseTo(0.6)
  })

  it('keeps a still scene at the maximum interval', () => {
    const result = selectChangeFrames(analysis(Array.from({ length: 51 }, () => 0)), { ...base, max_frame_interval_s: 2 })
    expect(result.selected.map((s) => s.trigger)).toEqual(['FIRST_FRAME', 'MAX_INTERVAL', 'MAX_INTERVAL', 'MAX_INTERVAL', 'MAX_INTERVAL', 'MAX_INTERVAL'])
  })

  it('keeps a scene cut even when the minimum interval has not elapsed', () => {
    const result = selectChangeFrames(analysis([0, 0, 0], { 1: 0.5 }), base)
    expect(result.selected.map((s) => s.trigger)).toEqual(['FIRST_FRAME', 'SCENE_CUT'])
    expect(result.selected[1]!.time_s).toBeCloseTo(0.2)
  })

  it('reports truncation when the candidate budget is reached', () => {
    const result = selectChangeFrames(analysis([0, 255, 0, 255, 0]), { ...base, max_candidate_frames: 2, min_frame_interval_s: 0 })
    expect(result.selected).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('implements the v1.2 fixed-interval fallback', () => {
    const result = selectFixedFrames(analysis(Array.from({ length: 11 }, () => 0)), 1, 100)
    expect(result.selected.map((s) => s.trigger)).toEqual(['FIRST_FRAME', 'FIXED_INTERVAL', 'FIXED_INTERVAL'])
    expect(result.selected.map((s) => s.time_s)).toEqual([0, 1, 2])
  })
})
