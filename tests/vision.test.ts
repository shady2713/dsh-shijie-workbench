import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createVisionTools, drawProbe, encodePng, type VisionAttachmentRef, type VisionAttachments } from '../src/vision.ts'

function attachmentRef(width: number, height: number): VisionAttachmentRef {
  return { attachmentId: `att_${width}x${height}` as VisionAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 1, width, height }
}

describe('E1 image probe', () => {
  it('encodes a valid PNG signature and requested dimensions', () => {
    const png = encodePng(8, 4, new Uint8Array(8 * 4 * 4).fill(255))
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(Buffer.from(png).readUInt32BE(16)).toBe(8)
    expect(Buffer.from(png).readUInt32BE(20)).toBe(4)
  })

  it('draws deterministic shapes inside the image', () => {
    const first = drawProbe(512, 384)
    const second = drawProbe(512, 384)
    expect(Buffer.from(first.png).equals(Buffer.from(second.png))).toBe(true)
    expect(first.shapes).toHaveLength(3)
    for (const shape of first.shapes) {
      expect(shape.box.left).toBeGreaterThanOrEqual(0)
      expect(shape.box.top).toBeGreaterThanOrEqual(0)
      expect(shape.box.right).toBeLessThan(512)
      expect(shape.box.bottom).toBeLessThan(384)
    }
    expect(first.shapes[0]!.box.left).toBeLessThan(first.shapes[2]!.box.left)
    expect(first.shapes[0]!.box.top).toBeLessThan(first.shapes[2]!.box.top)
  })

  it('saves the image and renders a real image content block', async () => {
    const saved: Array<{ width: number; height: number; mediaType: string }> = []
    const attachments: VisionAttachments = {
      async saveImage(input) {
        saved.push({ width: 512, height: 384, mediaType: input.mediaType })
        return attachmentRef(512, 384)
      },
    }
    const [tool] = createVisionTools(() => attachments)
    const value = (await tool!.execute!({}, {} as never)) as {
      status: string
      width: number
      height: number
      attachment: VisionAttachmentRef
    }
    expect(value.status).toBe('OK')
    expect(value.width).toBe(512)
    expect(value.height).toBe(384)
    expect(saved).toEqual([{ width: 512, height: 384, mediaType: 'image/png' }])
    const blocks = tool!.output.render({}, value as never) as ContentBlock[]
    expect(blocks.some((block) => block.type === 'image')).toBe(true)
    const image = blocks.find((block) => block.type === 'image') as { attachment: VisionAttachmentRef }
    expect(image.attachment.attachmentId).toBe('att_512x384')
  })

  it('accepts explicit dimensions and rejects out-of-range dimensions', async () => {
    const attachments: VisionAttachments = { async saveImage() { return attachmentRef(64, 64) } }
    const [tool] = createVisionTools(() => attachments)
    const value = (await tool!.execute!({ width: 64, height: 64 }, {} as never)) as { width: number; height: number }
    expect(value).toEqual(expect.objectContaining({ width: 64, height: 64 }))
    await expect(tool!.execute!({ width: 63 }, {} as never)).rejects.toThrow('between 64 and 2048')
  })

  it('fails clearly when no host attachment service exists', async () => {
    const [tool] = createVisionTools(() => undefined)
    await expect(tool!.execute!({}, {} as never)).rejects.toThrow('host attachment service is unavailable')
  })
})
