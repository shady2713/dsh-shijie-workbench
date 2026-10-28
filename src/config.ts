import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Directory holding the SQLite database and (later) artifacts. */
  dataDir: string
  mode: 'assisted' | 'unattended'
  ffmpegPath: string
  ffprobePath: string
  journal: 'AUTO' | 'DELETE' | 'WAL'
  /** Maximum accepted size of one imported evidence file, in bytes. */
  evidenceMaxBytes?: number
  /** Expose the E1 diagnostic tool that returns a generated image (used for host vision validation). */
  visionProbe?: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default(join(homedir(), '.dsh', 'shijie-workbench')).description('Directory for the workbench database'),
  mode: Schema.union(['assisted', 'unattended'] as const).default('assisted').description('assisted keeps a reviewer in the loop'),
  ffmpegPath: Schema.string().default('ffmpeg'),
  ffprobePath: Schema.string().default('ffprobe'),
  journal: Schema.union(['AUTO', 'DELETE', 'WAL'] as const)
    .default('AUTO')
    .description('AUTO uses WAL only on a SQLite build with the WAL-reset fix'),
  evidenceMaxBytes: Schema.number()
    .default(20 * 1024 * 1024)
    .min(1)
    .description('Maximum accepted size of one imported evidence file, in bytes (default 20 MiB)'),
  visionProbe: Schema.boolean()
    .default(false)
    .description('Expose shijie_e1_image_probe, the E1 host-vision diagnostic tool'),
}) as Schema<Config>
