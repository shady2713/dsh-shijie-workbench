import { deflateSync } from 'node:zlib'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Structural subset of the host attachment service used by the E1 probe. */
export interface VisionAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: { width: number; height: number }
}

export interface VisionAttachments {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name?: string }): Promise<VisionAttachmentRef>
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([header, typeBytes, data, crc])
}

/** Encode one opaque RGBA raster as a PNG without external image dependencies. */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 4) throw new Error('pixel buffer does not match dimensions')
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ])
}

export interface ShapeFact {
  shape: 'RECT' | 'CIRCLE'
  rgb: readonly [number, number, number]
  /** Inclusive pixel bounding box, origin at the top-left pixel. */
  box: { left: number; top: number; right: number; bottom: number }
}

function putPixel(pixels: Uint8Array, width: number, x: number, y: number, rgb: readonly [number, number, number]): void {
  const index = (y * width + x) * 4
  pixels[index] = rgb[0]
  pixels[index + 1] = rgb[1]
  pixels[index + 2] = rgb[2]
  pixels[index + 3] = 255
}

function fillRect(pixels: Uint8Array, width: number, box: ShapeFact['box'], rgb: readonly [number, number, number]): void {
  for (let y = box.top; y <= box.bottom; y++) for (let x = box.left; x <= box.right; x++) putPixel(pixels, width, x, y, rgb)
}

function fillCircle(
  pixels: Uint8Array,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
  rgb: readonly [number, number, number],
): void {
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      const dx = x - centerX
      const dy = y - centerY
      if (dx * dx + dy * dy <= radius * radius) putPixel(pixels, width, x, y, rgb)
    }
  }
}

/**
 * Draw a deterministic E1 test image with three coloured shapes on a white background.
 * Coordinates are derived from the requested size so the same facts hold at every size.
 */
export function drawProbe(width: number, height: number): { png: Uint8Array; shapes: ShapeFact[] } {
  const pixels = new Uint8Array(width * height * 4).fill(255)
  const red = [220, 30, 30] as const
  const green = [30, 160, 60] as const
  const blue = [30, 60, 220] as const
  const redBox = {
    left: Math.round(width * 0.08),
    top: Math.round(height * 0.08),
    right: Math.round(width * 0.27),
    bottom: Math.round(height * 0.23),
  }
  const greenBox = {
    left: Math.round(width * 0.43),
    top: Math.round(height * 0.42),
    right: Math.round(width * 0.58),
    bottom: Math.round(height * 0.57),
  }
  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.1))
  const centerX = Math.round(width * 0.74)
  const centerY = Math.round(height * 0.72)
  fillRect(pixels, width, redBox, red)
  fillRect(pixels, width, greenBox, green)
  fillCircle(pixels, width, centerX, centerY, radius, blue)
  return {
    png: encodePng(width, height, pixels),
    shapes: [
      { shape: 'RECT', rgb: red, box: redBox },
      { shape: 'RECT', rgb: green, box: greenBox },
      {
        shape: 'CIRCLE',
        rgb: blue,
        box: { left: centerX - radius, top: centerY - radius, right: centerX + radius, bottom: centerY + radius },
      },
    ],
  }
}

function numberArg(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 64 || value > 4096) {
    throw new Error('width and height must be integers between 64 and 4096')
  }
  return value
}

/**
 * The M1.5 E1 vision probe. This is a diagnostic tool, not an operation of the business
 * contract: it proves whether the host model route really receives tool-result images.
 */
export function createVisionTools(getAttachments: () => VisionAttachments | undefined): ToolDefinition[] {
  return [
    defineTool({
      name: 'shijie_e1_image_probe',
      description:
        'E1 diagnostic: return one generated test image. Report every coloured shape you actually see, including its colour, shape type and pixel bounding box (origin top-left).',
      parameters: {
        width: { type: 'number', description: 'Image width in pixels, 64-4096 (default 512)' },
        height: { type: 'number', description: 'Image height in pixels, 64-4096 (default 384)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            schema_version: { type: 'string', required: true },
            status: { type: 'string', required: true, enum: ['OK', 'ERROR'] },
            message: { type: 'string', required: true },
            width: { type: 'number', required: true },
            height: { type: 'number', required: true },
            attachment: { type: 'json', required: true },
          },
        },
        render: (_args, value) => {
          const v = value as unknown as { width: number; height: number; attachment: VisionAttachmentRef }
          return [
            {
              type: 'text',
              text: `E1 diagnostic image, ${v.width}x${v.height} pixels. List each coloured shape with its colour, type (rectangle/circle) and pixel bounding box (left, top, right, bottom), then state whether the image was legible.`,
            },
            { type: 'image', attachment: v.attachment } as ContentBlock,
          ]
        },
      },
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const a = args as { width?: number; height?: number }
        const width = numberArg(a.width, 512)
        const height = numberArg(a.height, 384)
        const attachments = getAttachments()
        if (!attachments) throw new Error('host attachment service is unavailable; cannot return an image block')
        const { png } = drawProbe(width, height)
        const attachment = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `e1-probe-${width}x${height}.png` })
        return {
          schema_version: '1.0',
          status: 'OK',
          message: `Generated a ${width}x${height} E1 test image.`,
          width,
          height,
          attachment,
        } as never
      },
    }),
  ]
}
