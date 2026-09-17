import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flushPendingQueueJobs, type PendingQueueEntry } from "./pending-queue";

describe("flushPendingQueueJobs", () => {
  it("flushes and polls every job with its retained repo and branch context", async () => {
    const entries: PendingQueueEntry[] = [
      { jobId: "old", provider: "gitea", project: "org/old", branch: "feature/old", sourceGroup: "old.md" },
      { jobId: "new", provider: "gitlab", project: "org/new", sourceGroup: "new.md" },
    ];
    const flushed: string[] = [];
    const polled: string[] = [];

    await flushPendingQueueJobs(entries, {
      flush: async (entry) => {
        flushed.push(`${entry.jobId}:${entry.provider}:${entry.project}:${entry.branch ?? ""}`);
      },
      status: async (entry) => {
        polled.push(`${entry.jobId}:${entry.provider}:${entry.project}:${entry.branch ?? ""}`);
        return { status: "done" };
      },
    }, { timeoutMs: 50, pollMs: 0 });

    assert.deepEqual(flushed, ["old:gitea:org/old:feature/old", "new:gitlab:org/new:"]);
    assert.deepEqual(polled, ["old:gitea:org/old:feature/old", "new:gitlab:org/new:"]);
  });

  it("blocks on conflict, error, or bounded timeout", async () => {
    const entry: PendingQueueEntry = {
      jobId: "job", provider: "gitea", project: "org/repo", branch: "feature/a", sourceGroup: "board.md",
    };
    for (const status of ["conflict", "error"] as const) {
      await assert.rejects(
        flushPendingQueueJobs([entry], {
          flush: async () => {},
          status: async () => ({ status, error: `${status}-detail` }),
        }, { timeoutMs: 50, pollMs: 0 }),
        new RegExp(`${status}-detail`)
      );
    }
    await assert.rejects(
      flushPendingQueueJobs([entry], {
        flush: async () => {},
        status: async () => ({ status: "pending" }),
      }, { timeoutMs: 0, pollMs: 0 }),
      /timeout/
    );
  });
});
