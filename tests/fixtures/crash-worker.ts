import { JobExecutor } from '../../src/domain/executor.ts'
import { Store } from '../../src/store.ts'

const dbPath = process.env.SHIJIE_DB
const dataDir = process.env.SHIJIE_DATA
if (!dbPath || !dataDir) throw new Error('SHIJIE_DB and SHIJIE_DATA are required')

const store = new Store({ path: dbPath })
const executor = new JobExecutor(store, dataDir)
const claim = executor.claimNext('crashed-worker', 60_000, ['media.acquire'])
if (!claim) throw new Error('no media.acquire job to claim')
process.stdout.write(`${claim.job_id}\n`)
// Simulate a worker crash after claiming: exit without heartbeat or completion.
process.exit(0)
