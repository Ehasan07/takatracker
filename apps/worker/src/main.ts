import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ workers. M0 wires up the connection and a heartbeat queue so the
 * plumbing is proven; the real jobs (message parsing, recurring transactions,
 * monthly reports, due-date reminders) arrive with M7, M13 and M18.
 */

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const QUEUE_HEARTBEAT = 'heartbeat';

export const heartbeatQueue = new Queue(QUEUE_HEARTBEAT, { connection });

const worker = new Worker(
  QUEUE_HEARTBEAT,
  async (job: Job<{ at: string }>) => {
    return { pong: job.data.at };
  },
  { connection, concurrency: 4 },
);

worker.on('failed', (job, err) => {
  // Ingestion events are logged without bodies (spec §4.7).
  console.error(`[worker] job ${job?.id ?? '?'} failed: ${err.message}`);
});

worker.on('ready', () => {
  console.log('[worker] connected to Redis, listening on queue:', QUEUE_HEARTBEAT);
});

const shutdown = async (): Promise<void> => {
  await worker.close();
  await heartbeatQueue.close();
  await connection.quit();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
