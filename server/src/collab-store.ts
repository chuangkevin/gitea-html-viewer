import crypto from "node:crypto";
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS collab_state (
  doc_key     TEXT PRIMARY KEY,
  state       BLOB NOT NULL,
  text_hash   TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`);

const selectState = db.prepare("SELECT state, text_hash FROM collab_state WHERE doc_key = ?");
const upsertState = db.prepare(`
INSERT INTO collab_state (doc_key, state, text_hash, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(doc_key) DO UPDATE SET
  state = excluded.state,
  text_hash = excluded.text_hash,
  updated_at = excluded.updated_at
`);
const deleteState = db.prepare("DELETE FROM collab_state WHERE doc_key = ?");
const deleteStale = db.prepare("DELETE FROM collab_state WHERE updated_at < ?");

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function loadCollabState(docKey: string): { state: Uint8Array; textHash: string } | null {
  const row = selectState.get(docKey) as { state: Buffer; text_hash: string } | undefined;
  if (!row) return null;
  return { state: new Uint8Array(row.state), textHash: row.text_hash };
}

export function saveCollabState(docKey: string, state: Uint8Array, textHash: string): void {
  upsertState.run(docKey, Buffer.from(state), textHash, Date.now());
}

export function clearCollabState(docKey: string): void {
  deleteState.run(docKey);
}

export function purgeStaleCollabState(maxAgeMs: number): number {
  const result = deleteStale.run(Date.now() - maxAgeMs);
  return result.changes;
}
