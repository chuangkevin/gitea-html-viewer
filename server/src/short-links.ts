import crypto from "node:crypto";
import { db } from "./db.js";

export type ShortLinkErrorCode =
  | "invalid_alias"
  | "invalid_target"
  | "invalid_label"
  | "invalid_enabled"
  | "alias_exists"
  | "alias_generation_failed";

export class ShortLinkError extends Error {
  constructor(public code: ShortLinkErrorCode) {
    super(code);
  }
}

export interface ShortLink {
  id: string;
  alias: string;
  targetPath: string;
  label: string | null;
  createdBy: string;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ShortLinkRow {
  id: string;
  alias: string;
  target_path: string;
  label: string | null;
  created_by: string;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ShortLinkResponse extends ShortLink {
  goUrl: string;
}

export interface CreateShortLinkInput {
  alias?: string | null;
  targetPath: string;
  label?: string | null;
  createdBy: string;
}

export interface UpdateShortLinkInput {
  targetPath?: string;
  label?: string | null;
  isEnabled?: boolean;
}

const ALIAS_RE = /^[a-z0-9-]{2,48}$/;
const ALIAS_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// edit/site/present receive an URL-encoded project as one route parameter.
// Direct presentation also accepts a trailing document path after that project.
const DOCUMENT_UI_ROUTE = /^\/(?:edit|site|present)\/(?:github|gitlab)\/[^/]+$/;
const DIRECT_PRESENTATION_ROUTE = /^\/p\/(?:github|gitlab)\/[^/]+(?:\/.*)?$/;

function rowToShortLink(row: ShortLinkRow): ShortLink {
  return {
    id: row.id,
    alias: row.alias,
    targetPath: row.target_path,
    label: row.label,
    createdBy: row.created_by,
    isEnabled: row.is_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function shortLinkToResponse(link: ShortLink, baseUrl: string): ShortLinkResponse {
  return { ...link, goUrl: `${baseUrl.replace(/\/+$/, "")}/go/${link.alias}` };
}

export function validateShortLinkAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new ShortLinkError("invalid_alias");
  const alias = raw.trim().toLowerCase();
  if (!ALIAS_RE.test(alias)) throw new ShortLinkError("invalid_alias");
  return alias;
}

function normalizeOptionalLabel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ShortLinkError("invalid_label");
  const label = raw.trim();
  return label ? label.slice(0, 160) : null;
}

function decodePathForValidation(pathOnly: string): string {
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    throw new ShortLinkError("invalid_target");
  }
}

export function validateShortLinkTarget(raw: unknown): string {
  if (typeof raw !== "string") throw new ShortLinkError("invalid_target");
  const target = raw.trim();
  if (!target || target.length > 2048) throw new ShortLinkError("invalid_target");
  if (/[\x00-\x1f\x7f]/.test(target) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)) {
    throw new ShortLinkError("invalid_target");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw new ShortLinkError("invalid_target");
  if (!target.startsWith("/") || target.startsWith("//")) throw new ShortLinkError("invalid_target");
  if (target.includes("\\") || /%5c/i.test(target)) throw new ShortLinkError("invalid_target");

  const pathOnly = target.split(/[?#]/, 1)[0];
  const decodedPath = decodePathForValidation(pathOnly);
  if (/[\x00-\x1f\x7f]/.test(decodedPath) || decodedPath.includes("\\") || decodedPath.startsWith("//")) {
    throw new ShortLinkError("invalid_target");
  }
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ShortLinkError("invalid_target");
  }
  if (!DOCUMENT_UI_ROUTE.test(pathOnly) && !DIRECT_PRESENTATION_ROUTE.test(pathOnly)) {
    throw new ShortLinkError("invalid_target");
  }
  return target;
}

export function isValidShortLinkTarget(raw: unknown): boolean {
  try {
    validateShortLinkTarget(raw);
    return true;
  } catch {
    return false;
  }
}

function randomAlias(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let alias = "";
  for (const byte of bytes) alias += ALIAS_CHARS[byte % ALIAS_CHARS.length];
  return alias;
}

function isUniqueAliasError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "SQLITE_CONSTRAINT_UNIQUE" || Boolean(err?.message?.includes("short_links.alias"));
}

function getShortLinkById(id: string): ShortLink | null {
  const row = db.prepare("SELECT * FROM short_links WHERE id = ?").get(id) as ShortLinkRow | undefined;
  return row ? rowToShortLink(row) : null;
}

function insertShortLink(id: string, alias: string, targetPath: string, label: string | null, createdBy: string, now: number): void {
  db.prepare(
    `INSERT INTO short_links (id, alias, target_path, label, created_by, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, alias, targetPath, label, createdBy, now, now);
}

export function createShortLink(input: CreateShortLinkInput, generateAlias: () => string = randomAlias): ShortLink {
  const targetPath = validateShortLinkTarget(input.targetPath);
  const label = normalizeOptionalLabel(input.label);
  const createdBy = input.createdBy.trim() || "admin";
  const now = Date.now();

  if (input.alias !== undefined && input.alias !== null && typeof input.alias !== "string") {
    throw new ShortLinkError("invalid_alias");
  }
  const requestedAlias = typeof input.alias === "string" && input.alias.trim() ? validateShortLinkAlias(input.alias) : null;
  if (requestedAlias) {
    const id = crypto.randomUUID();
    try {
      insertShortLink(id, requestedAlias, targetPath, label, createdBy, now);
    } catch (e) {
      if (isUniqueAliasError(e)) throw new ShortLinkError("alias_exists");
      throw e;
    }
    return getShortLinkById(id)!;
  }

  for (let attempt = 0; attempt < 24; attempt++) {
    const alias = validateShortLinkAlias(generateAlias());
    const id = crypto.randomUUID();
    try {
      insertShortLink(id, alias, targetPath, label, createdBy, now);
      return getShortLinkById(id)!;
    } catch (e) {
      if (isUniqueAliasError(e)) continue;
      throw e;
    }
  }
  throw new ShortLinkError("alias_generation_failed");
}

export function listShortLinks(query = ""): ShortLink[] {
  const q = query.trim();
  const rows = q
    ? (db
        .prepare(
          `SELECT * FROM short_links
           WHERE alias LIKE ? OR target_path LIKE ? OR label LIKE ?
           ORDER BY updated_at DESC, created_at DESC`
        )
        .all(`%${q}%`, `%${q}%`, `%${q}%`) as ShortLinkRow[])
    : (db
        .prepare("SELECT * FROM short_links ORDER BY updated_at DESC, created_at DESC")
        .all() as ShortLinkRow[]);
  return rows.map(rowToShortLink);
}

export function updateShortLink(id: string, input: UpdateShortLinkInput): ShortLink | null {
  const existing = db.prepare("SELECT * FROM short_links WHERE id = ?").get(id) as ShortLinkRow | undefined;
  if (!existing) return null;
  const targetPath = input.targetPath === undefined ? existing.target_path : validateShortLinkTarget(input.targetPath);
  const label = input.label === undefined ? existing.label : normalizeOptionalLabel(input.label);
  if (input.isEnabled !== undefined && typeof input.isEnabled !== "boolean") throw new ShortLinkError("invalid_enabled");
  const isEnabled = input.isEnabled === undefined ? existing.is_enabled : input.isEnabled ? 1 : 0;
  db.prepare("UPDATE short_links SET target_path = ?, label = ?, is_enabled = ?, updated_at = ? WHERE id = ?").run(
    targetPath,
    label,
    isEnabled,
    Date.now(),
    id
  );
  return getShortLinkById(id);
}

export function resolveShortLink(alias: string): ShortLink | null {
  let normalizedAlias: string;
  try {
    normalizedAlias = validateShortLinkAlias(alias);
  } catch {
    return null;
  }
  const row = db
    .prepare("SELECT * FROM short_links WHERE alias = ? AND is_enabled = 1")
    .get(normalizedAlias) as ShortLinkRow | undefined;
  if (!row || !isValidShortLinkTarget(row.target_path)) return null;
  return rowToShortLink(row);
}
