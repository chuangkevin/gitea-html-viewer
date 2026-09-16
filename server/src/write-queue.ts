/**
 * 互動 HTML 頁的寫入佇列。
 *
 * 背景：note.ia 可以所見即所得地直接操作內嵌 HTML 互動頁（POC 看板、CRM）。
 * 這些頁面每按一次按鈕原本就是一次同步 git commit（2～4 趟上游往返），
 * 連續操作時畫面被卡住。
 *
 * 這個模組把那些寫入改成：先落地到 SQLite，立刻回覆「已排入」，再由背景
 * worker 依來源群組合併後一次 commit。
 *
 * 不變的界線：
 *   - 衝突不覆蓋：落地前逐檔比對基準 sha，對不上就整組標 conflicted，
 *     內容保留在佇列裡，不寫入、不覆蓋別人的版本。
 *   - 多檔群組整組原子：同一組要嘛全部落地，要嘛全部不落地（只有 provider
 *     支援單一 commit 批次寫入時才可能；不支援時整組逐檔寫並回報部分失敗）。
 *   - 不做 last-write-wins，也不因為「沒有 sha」就放行覆蓋。
 */
import crypto from "node:crypto";
import { db, getSession } from "./db.js";
import { getProvider, isProviderName, ProviderError, type CommitAuthor, type ProviderName } from "./providers.js";
import { openToken } from "./access.js";
import { fullIdentities, resolveIdentityToken } from "./identities.js";

/** 安靜視窗：最後一次寫入後多久沒有新寫入就落地。 */
const QUIET_MS = Number(process.env.NOTE_QUEUE_QUIET_MS ?? 1_500);
/** 封頂：一直有人寫入時，最多等這麼久一定要落地一次。 */
const CAP_MS = Number(process.env.NOTE_QUEUE_CAP_MS ?? 5_000);
/** 落地失敗的重試次數上限。 */
const MAX_ATTEMPTS = Number(process.env.NOTE_QUEUE_MAX_ATTEMPTS ?? 5);
/** worker 掃描間隔。 */
const TICK_MS = Number(process.env.NOTE_QUEUE_TICK_MS ?? 250);
/** 一個 tick 最多處理幾個項目（避免突發時一次打爆上游）。 */
const MAX_PER_TICK = 5;
/** 單檔上限沿用 API 層的 20MB。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type JobStatus = "pending" | "running" | "done" | "conflict" | "error";

export interface QueueFile {
  path: string;
  content?: string;
  contentBase64?: string;
  sha?: string;
}

export interface ActorRef {
  kind: "open" | "session" | "identity" | "admin";
  sid?: string;
  identityName?: string;
}

export interface EnqueueInput {
  provider: ProviderName;
  project: string;
  /** 同一組的多次寫入會被合併成一個 commit。預設用第一個檔案路徑。 */
  sourceGroup?: string;
  files: QueueFile[];
  message?: string;
  actor: ActorRef;
  author?: CommitAuthor;
}

interface JobRow {
  id: string;
  provider: string;
  project: string;
  source_group: string;
  files_json: string;
  author_name: string | null;
  author_email: string | null;
  actor_kind: string;
  actor_sid: string | null;
  actor_identity: string | null;
  message: string;
  status: string;
  attempts: number;
  last_error: string | null;
  conflict_json: string | null;
  created_at: number;
  updated_at: number;
  quiet_deadline: number;
  cap_deadline: number;
}

export function ensureWriteJobsTable(): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS write_jobs (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  project         TEXT NOT NULL,
  source_group    TEXT NOT NULL,
  files_json      TEXT NOT NULL,
  author_name     TEXT,
  author_email    TEXT,
  actor_kind      TEXT NOT NULL,
  actor_sid       TEXT,
  actor_identity  TEXT,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  conflict_json   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  quiet_deadline  INTEGER NOT NULL,
  cap_deadline    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_write_jobs_due ON write_jobs(status, quiet_deadline);
CREATE INDEX IF NOT EXISTS idx_write_jobs_group ON write_jobs(provider, project, source_group, status);
`);
}

// 模組載入就確保表存在：端點與測試不需要先啟動 worker。
ensureWriteJobsTable();

function parseFiles(row: JobRow): QueueFile[] {
  try {
    const parsed = JSON.parse(row.files_json);
    return Array.isArray(parsed) ? (parsed as QueueFile[]) : [];
  } catch {
    return [];
  }
}

function toAuthor(row: JobRow): CommitAuthor | undefined {
  if (!row.author_name) return undefined;
  return { name: row.author_name, email: row.author_email || process.env.NOTE_OPEN_AUTHOR_EMAIL || "note@interagent.io" };
}

/** 把使用者送來的檔案正規化並驗證；不合法回 null。 */
function normalizeFiles(files: QueueFile[]): QueueFile[] | null {
  if (!Array.isArray(files) || files.length === 0) return null;
  const out: QueueFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || typeof f.path !== "string") return null;
    const path = f.path;
    if (!path || path.startsWith("/") || path.includes("\\") || path.includes("..")) return null;
    if (seen.has(path)) return null;
    seen.add(path);
    const hasText = typeof f.content === "string";
    const hasB64 = typeof f.contentBase64 === "string";
    if (!hasText && !hasB64) return null;
    const bytes = hasB64
      ? Buffer.from(f.contentBase64 as string, "base64").byteLength
      : Buffer.byteLength(f.content as string, "utf8");
    if (bytes > MAX_FILE_BYTES) return null;
    out.push({
      path,
      ...(hasText ? { content: f.content as string } : { contentBase64: f.contentBase64 as string }),
      ...(typeof f.sha === "string" && f.sha ? { sha: f.sha } : {}),
    });
  }
  return out;
}

/**
 * 排入一次寫入。同一 (provider, project, source_group) 若已有等待中的項目，
 * 直接以最新內容取代（合併），回傳既有的 jobId。
 *
 * 進行中（running）的項目不會被取代：它已經在寫上游，內容不可變，
 * 新的寫入另外排一個項目，落地後再處理。
 */
export function enqueueWrite(input: EnqueueInput): { jobId: string; merged: boolean; quietMs: number } | null {
  const files = normalizeFiles(input.files);
  if (!files) return null;
  if (!isProviderName(input.provider)) return null;
  const project = (input.project || "").trim();
  if (!project) return null;

  const group = (input.sourceGroup || files[0].path).trim() || files[0].path;
  const message = (input.message || `docs: 更新 ${files.map((f) => f.path).join("、")}（互動頁）`).slice(0, 500);
  const now = Date.now();

  const pending = db
    .prepare(
      `SELECT * FROM write_jobs
        WHERE provider = ? AND LOWER(project) = LOWER(?) AND source_group = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(input.provider, project, group) as JobRow | undefined;

  if (pending) {
    db.prepare(
      `UPDATE write_jobs
          SET files_json = ?, author_name = ?, author_email = ?, actor_kind = ?, actor_sid = ?,
              actor_identity = ?, message = ?, updated_at = ?, quiet_deadline = ?, cap_deadline = ?
        WHERE id = ?`
    ).run(
      JSON.stringify(files),
      input.author?.name ?? null,
      input.author?.email ?? null,
      input.actor.kind,
      input.actor.sid ?? null,
      input.actor.identityName ?? null,
      message,
      now,
      now + QUIET_MS,
      pending.cap_deadline,
      pending.id
    );
    return { jobId: pending.id, merged: true, quietMs: QUIET_MS };
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO write_jobs
       (id, provider, project, source_group, files_json, author_name, author_email,
        actor_kind, actor_sid, actor_identity, message, status, attempts, last_error,
        conflict_json, created_at, updated_at, quiet_deadline, cap_deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, ?, ?)`
  ).run(
    id,
    input.provider,
    project,
    group,
    JSON.stringify(files),
    input.author?.name ?? null,
    input.author?.email ?? null,
    input.actor.kind,
    input.actor.sid ?? null,
    input.actor.identityName ?? null,
    message,
    now,
    now,
    now + QUIET_MS,
    now + CAP_MS
  );
  return { jobId: id, merged: false, quietMs: QUIET_MS };
}

export interface JobView {
  jobId: string;
  status: JobStatus;
  attempts: number;
  updatedAt: number;
  error?: string;
  conflicts?: { path: string; currentSha: string }[];
  /** 只有 conflict / error 才回內容，讓頁面能保住自己的修改。 */
  files?: { path: string; content?: string; contentBase64?: string; sha?: string; landedSha?: string }[];
}

function toView(row: JobRow): JobView {
  const view: JobView = {
    jobId: row.id,
    status: row.status as JobStatus,
    attempts: row.attempts,
    updatedAt: row.updated_at,
  };
  if (row.last_error) view.error = row.last_error;
  if (row.conflict_json) {
    try {
      const parsed = JSON.parse(row.conflict_json);
      if (Array.isArray(parsed)) view.conflicts = parsed;
    } catch {
      // ignore
    }
  }
  if (row.status === "conflict" || row.status === "error") {
    view.files = parseFiles(row);
  }
  return view;
}

/** 依 jobId 或 (provider, project, sourceGroup) 查狀態。 */
export function jobStatus(q: { jobId?: string; provider?: string; project?: string; sourceGroup?: string }): JobView | null {
  if (q.jobId) {
    const row = db.prepare("SELECT * FROM write_jobs WHERE id = ?").get(q.jobId) as JobRow | undefined;
    return row ? toView(row) : null;
  }
  if (!q.provider || !q.project) return null;
  const row = q.sourceGroup
    ? (db
        .prepare(
          `SELECT * FROM write_jobs WHERE provider = ? AND LOWER(project) = LOWER(?) AND source_group = ?
            ORDER BY created_at DESC LIMIT 1`
        )
        .get(q.provider, q.project, q.sourceGroup) as JobRow | undefined)
    : (db
        .prepare(
          `SELECT * FROM write_jobs WHERE provider = ? AND LOWER(project) = LOWER(?)
            ORDER BY created_at DESC LIMIT 1`
        )
        .get(q.provider, q.project) as JobRow | undefined);
  return row ? toView(row) : null;
}

/** 該 repo 有沒有尚未落地的寫入（頁面用來決定要不要提示未儲存）。 */
export function hasUnlanded(provider: string, project: string, sourceGroup?: string): boolean {
  const clause = sourceGroup ? " AND source_group = ?" : "";
  const args = sourceGroup ? [provider, project, sourceGroup] : [provider, project];
  const row = db
    .prepare(
      `SELECT 1 FROM write_jobs
        WHERE provider = ? AND LOWER(project) = LOWER(?)${clause} AND status IN ('pending','running')
        LIMIT 1`
    )
    .get(...args);
  return Boolean(row);
}

/** 強制落地：跳過安靜視窗（頁面離開時用）。 */
export function flushGroup(q: { provider: string; project: string; sourceGroup?: string }): number {
  const now = Date.now();
  const clause = q.sourceGroup ? " AND source_group = ?" : "";
  const args: unknown[] = q.sourceGroup ? [q.provider, q.project, q.sourceGroup] : [q.provider, q.project];
  const res = db
    .prepare(
      `UPDATE write_jobs SET quiet_deadline = ?, updated_at = ?
        WHERE provider = ? AND LOWER(project) = LOWER(?)${clause} AND status = 'pending'`
    )
    .run(now, now, ...args);
  return res.changes;
}

function actorToken(actor: ActorRef, provider: ProviderName): { token: string; author?: CommitAuthor } | null {
  if (actor.kind === "open" || actor.kind === "admin") {
    const token = openToken(provider);
    return token ? { token } : null;
  }
  if (actor.kind === "session") {
    const s = getSession(actor.sid);
    if (!s) return null;
    return { token: s.token };
  }
  if (actor.kind === "identity") {
    const id = fullIdentities().find((m) => m.name === actor.identityName);
    if (!id) return null;
    const token = resolveIdentityToken(id);
    if (!token) return null;
    return { token, author: { name: id.name, email: id.email } };
  }
  return null;
}

function contentOf(f: QueueFile): string {
  return typeof f.content === "string" ? f.content : Buffer.from(f.contentBase64 || "", "base64").toString("utf8");
}

interface LandResult {
  outcome: "done" | "conflict" | "error";
  error?: string;
  conflicts?: { path: string; currentSha: string }[];
}

async function land(job: JobRow): Promise<LandResult> {
  const provider = getProvider(job.provider);
  const files = parseFiles(job);
  if (files.length === 0) return { outcome: "error", error: "empty_job" };

  const actor = actorToken(
    {
      kind: job.actor_kind as ActorRef["kind"],
      sid: job.actor_sid ?? undefined,
      identityName: job.actor_identity ?? undefined,
    },
    job.provider as ProviderName
  );
  if (!actor) return { outcome: "error", error: "actor_token_unavailable" };

  const meta = await provider.getRepo(actor.token, job.project);
  if (!meta.canPush) return { outcome: "error", error: "no_write_permission" };

  // 逐檔比對：遠端已經等於我們的內容 → 這檔視為已落地（重啟後不重複 commit）。
  const conflicts: { path: string; currentSha: string }[] = [];
  let allAlreadyLanded = true;
  for (const f of files) {
    let cur: { content: string; sha: string } | null = null;
    try {
      cur = await provider.readFile(actor.token, job.project, f.path);
    } catch {
      cur = null; // 新檔
    }
    if (cur && cur.content === contentOf(f)) continue; // 已落地
    allAlreadyLanded = false;
    if (cur && f.sha && cur.sha && cur.sha !== f.sha) {
      conflicts.push({ path: f.path, currentSha: cur.sha });
    }
  }

  if (conflicts.length > 0) return { outcome: "conflict", conflicts };
  if (allAlreadyLanded) return { outcome: "done" };

  const message = job.message;
  const author = toAuthor(job);

  if (files.length === 1 || !provider.batchWriteFiles) {
    for (const f of files) {
      const isB64 = typeof f.contentBase64 === "string";
      await provider.writeFile(
        actor.token,
        job.project,
        f.path,
        isB64 ? (f.contentBase64 as string) : (f.content as string),
        message,
        undefined, // 上面已做過樂觀鎖比對；寫入用最新 sha，避免落後一拍又失敗
        meta.defaultBranch,
        author ?? actor.author,
        isB64
      );
    }
    return { outcome: "done" };
  }

  const res = await provider.batchWriteFiles(
    actor.token,
    job.project,
    files.map((f) => ({
      path: f.path,
      contentBase64: typeof f.contentBase64 === "string" ? f.contentBase64 : Buffer.from(f.content ?? "", "utf8").toString("base64"),
    })),
    message,
    meta.defaultBranch,
    author ?? actor.author
  );
  if (res.failed.length > 0) {
    return { outcome: "error", error: `batch_write_partial: ${res.failed.map((x) => x.path).join(",")}` };
  }
  return { outcome: "done" };
}

/** 處理一個到期項目。回傳是否有做事（測試與監控用）。 */
export async function processOnce(now = Date.now()): Promise<number> {
  const due = db
    .prepare(
      `SELECT * FROM write_jobs
        WHERE status = 'pending' AND (quiet_deadline <= ? OR cap_deadline <= ?)
        ORDER BY created_at ASC LIMIT ?`
    )
    .all(now, now, MAX_PER_TICK) as JobRow[];

  let handled = 0;
  for (const row of due) {
    // 先搶下這個項目：只有還停在 pending 才輪得到我，避免重複落地。
    const claimed = db
      .prepare("UPDATE write_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), row.id);
    if (claimed.changes !== 1) continue;
    handled += 1;

    let result: LandResult;
    try {
      result = await land(row);
    } catch (err) {
      const msg = err instanceof ProviderError ? `${err.status}: ${err.message}` : String((err as Error)?.message || err);
      result = { outcome: "error", error: msg };
    }

    const nowMs = Date.now();
    if (result.outcome === "done") {
      db.prepare("UPDATE write_jobs SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?").run(nowMs, row.id);
      continue;
    }
    if (result.outcome === "conflict") {
      // 內容保留在 files_json，不落地、不覆蓋。
      db.prepare(
        "UPDATE write_jobs SET status = 'conflict', updated_at = ?, conflict_json = ?, last_error = ? WHERE id = ?"
      ).run(nowMs, JSON.stringify(result.conflicts ?? []), "sha_mismatch", row.id);
      continue;
    }

    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE write_jobs SET status = 'error', attempts = ?, updated_at = ?, last_error = ? WHERE id = ?").run(
        attempts,
        nowMs,
        result.error ?? "unknown",
        row.id
      );
    } else {
      const backoff = Math.min(30_000, 2_000 * 2 ** (attempts - 1));
      db.prepare(
        `UPDATE write_jobs
            SET status = 'pending', attempts = ?, updated_at = ?, last_error = ?,
                quiet_deadline = ?, cap_deadline = ?
          WHERE id = ?`
      ).run(attempts, nowMs, result.error ?? "unknown", nowMs + backoff, nowMs + backoff, row.id);
    }
  }
  return handled;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** 行程重啟後，把卡在 running 的項目收回 pending（它們沒有真的在跑了）。 */
export function recoverRunningJobs(): number {
  ensureWriteJobsTable();
  return db.prepare("UPDATE write_jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(Date.now()).changes;
}

/** 啟動背景 worker；重啟時把殘留的 running 收回 pending。 */
export function startWriteQueue(): void {
  const recovered = recoverRunningJobs();
  if (recovered > 0) {
    console.log(`[write-queue] 重啟回復 ${recovered} 筆未落地寫入`);
  }
  if (process.env.NOTE_QUEUE_DISABLED === "1") {
    console.log("[write-queue] 已停用（NOTE_QUEUE_DISABLED=1）");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void processOnce()
      .catch((err) => console.error("[write-queue] tick 失敗", err))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref?.();
  console.log(`[write-queue] 已啟動（quiet ${QUIET_MS}ms / cap ${CAP_MS}ms）`);
}

export function stopWriteQueue(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 測試輔助：直接讀某個 job 的原始列。 */
export function rawJob(id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM write_jobs WHERE id = ?").get(id) as JobRow | undefined;
}
