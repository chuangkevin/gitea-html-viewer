import { db } from "./db.js";
import type { ProviderName } from "./providers.js";

export type AccessMode = "open" | "login" | "admin";

export function isAccessMode(v: unknown): v is AccessMode {
  return v === "open" || v === "login" || v === "admin";
}

export function getMode(provider: ProviderName, project: string): AccessMode {
  const p = (project || "").trim();
  if (!p) return "login";
  const row = db
    .prepare("SELECT mode FROM repo_access WHERE provider = ? AND LOWER(project) = LOWER(?)")
    .get(provider, p) as { mode: string } | undefined;
  if (row && isAccessMode(row.mode)) return row.mode;
  return "login";
}

export function setMode(provider: ProviderName, project: string, mode: AccessMode, by: string): void {
  const p = (project || "").trim();
  if (!p || !isAccessMode(mode)) return;
  db.prepare("DELETE FROM repo_access WHERE provider = ? AND LOWER(project) = LOWER(?)").run(provider, p);
  db.prepare("INSERT INTO repo_access (provider, project, mode, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)").run(
    provider,
    p,
    mode,
    Date.now(),
    by
  );
}

export function removeEntry(provider: ProviderName, project: string): void {
  const p = (project || "").trim();
  if (!p) return;
  db.prepare("DELETE FROM repo_access WHERE provider = ? AND LOWER(project) = LOWER(?)").run(provider, p);
}

export function listEntries(): {
  provider: string;
  project: string;
  mode: AccessMode;
  updatedAt: number;
  updatedBy: string | null;
}[] {
  const rows = db
    .prepare("SELECT provider, project, mode, updated_at, updated_by FROM repo_access ORDER BY updated_at DESC")
    .all() as { provider: string; project: string; mode: AccessMode; updated_at: number; updated_by: string | null }[];
  return rows.map((r) => ({
    provider: r.provider,
    project: r.project,
    mode: r.mode,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

export function openToken(provider: ProviderName): string {
  if (provider === "github") return process.env.GITHUB_OPEN_TOKEN || "";
  if (provider === "gitlab") return process.env.GITLAB_OPEN_TOKEN || "";
  return "";
}

export function openTokenReady(provider: ProviderName): boolean {
  return Boolean(openToken(provider));
}

export function defaultGuestAuthor(): { name: string; email: string } {
  return {
    name: process.env.NOTE_OPEN_AUTHOR_NAME || "note 訪客",
    email: process.env.NOTE_OPEN_AUTHOR_EMAIL || "note@interagent.io",
  };
}
