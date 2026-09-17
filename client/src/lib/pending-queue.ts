export interface PendingQueueEntry {
  jobId: string;
  provider: string;
  project: string;
  branch?: string;
  sourceGroup: string;
}

type QueueStatus = {
  status: "pending" | "running" | "done" | "conflict" | "error";
  error?: string;
};

interface PendingQueueApi {
  flush: (entry: PendingQueueEntry) => Promise<unknown>;
  status: (entry: PendingQueueEntry) => Promise<QueueStatus>;
}

interface FlushOptions {
  timeoutMs?: number;
  pollMs?: number;
  onDone?: (entry: PendingQueueEntry) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 250;

export async function flushPendingQueueJobs(
  entries: PendingQueueEntry[],
  api: PendingQueueApi,
  options: FlushOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  for (const entry of entries) {
    await api.flush(entry);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await api.status(entry);
      if (result.status === "done") {
        options.onDone?.(entry);
        break;
      }
      if (result.status === "conflict" || result.status === "error") {
        throw new Error(result.error || `queue_${result.status}`);
      }
      if (Date.now() >= deadline) throw new Error("queue_flush_timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
