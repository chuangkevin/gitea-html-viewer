import path from "node:path";
import { ProviderError } from "./providers.js";

export interface ImportMap {
  imports: Record<string, string>;
}

function encodeFolderPath(folderPath: string): string {
  if (!folderPath) return "";
  const endsWithSlash = folderPath.endsWith("/");
  const segments = folderPath.split("/");
  const encodedSegments = segments.map((seg) => encodeURIComponent(seg));
  let result = encodedSegments.join("/");
  if (!endsWithSlash && !result.endsWith("/")) {
    result += "/";
  }
  return result;
}

export function buildPreviewBaseUrl(opts: {
  provider: string;
  project: string;
  folderPath?: string;
  grant?: string | null;
  branch?: string;
}): string {
  const { provider, project, folderPath = "", grant, branch } = opts;
  const cleanFolder = encodeFolderPath(folderPath);
  const encodedProject = encodeURIComponent(project);
  if (grant) {
    if (provider === "gitea" && branch) return `/site-assetstb/${encodeURIComponent(grant)}/${encodeURIComponent(branch)}/${provider}/${encodedProject}/${cleanFolder}`;
    return `/site-assetst/${encodeURIComponent(grant)}/${provider}/${encodedProject}/${cleanFolder}`;
  }
  if (provider === "gitea" && branch) return `/site-assetsb/${encodeURIComponent(branch)}/${provider}/${encodedProject}/${cleanFolder}`;
  return `/site-assets/${provider}/${encodedProject}/${cleanFolder}`;
}

const CRM_CANONICAL_PROVIDER = "gitlab";
const CRM_CANONICAL_PROJECT = "interagent-io/global-doc";
const CRM_CANONICAL_ASSET_PATH = "內部/CRM/crm.html";

function encodePathQueryValue(filePath: string): string {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function cleanRawQuery(rawQuery: string | undefined): string {
  if (!rawQuery) {
    return "";
  }
  const withoutPrefix = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  const hashIndex = withoutPrefix.indexOf("#");
  return hashIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, hashIndex);
}

export function buildCrmAssetCanonicalRedirectLocation(opts: {
  provider: string;
  project: string;
  filePath: string;
  route: "public" | "grant";
  rawQuery?: string;
}): string | null {
  if (
    opts.route !== "public" ||
    opts.provider !== CRM_CANONICAL_PROVIDER ||
    opts.project !== CRM_CANONICAL_PROJECT ||
    opts.filePath !== CRM_CANONICAL_ASSET_PATH
  ) {
    return null;
  }

  const params = new URLSearchParams(cleanRawQuery(opts.rawQuery));
  const preserved = new URLSearchParams();
  for (const [key, value] of params) {
    if (key !== "f") {
      preserved.append(key, value);
    }
  }

  const base = `/site/${CRM_CANONICAL_PROVIDER}/${encodeURIComponent(CRM_CANONICAL_PROJECT)}`;
  const preservedQuery = preserved.toString();
  const canonicalFile = `f=${encodePathQueryValue(CRM_CANONICAL_ASSET_PATH)}`;
  return `${base}?${preservedQuery ? `${preservedQuery}&` : ""}${canonicalFile}`;
}

export function determineEffectiveGrant(
  grantQuery: string | null | undefined,
  grantToken: string | null | undefined,
  usingGrant: boolean
): string | null {
  if (!grantQuery || !grantToken || !usingGrant) {
    return null;
  }
  return grantQuery;
}

export function shouldServeCssShim(filePath: string, sitePreviewCssQuery: unknown): boolean {
  if (sitePreviewCssQuery !== "1") {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".css";
}

export function resolvePreviewAssetPath(filePath: string): string {
  if (!filePath || filePath === "/") {
    return "index.html";
  }
  if (filePath.endsWith("/")) {
    return `${filePath.replace(/^\/+/, "")}index.html`;
  }
  return filePath;
}

const UNSCOPED_PKG_REGEX = /^[a-zA-Z0-9_-]+$/;
const SCOPED_PKG_REGEX = /^@[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/;

function isValidNpmPackageName(name: string): boolean {
  if (!name || name.includes("..") || name.includes("<") || name.includes(">")) {
    return false;
  }
  return UNSCOPED_PKG_REGEX.test(name) || SCOPED_PKG_REGEX.test(name);
}

function cleanVersionRange(ver: string): string {
  if (typeof ver !== "string") return "";
  const cleaned = ver.replace(/^[~^>=<v=]+/, "").trim();
  return cleaned;
}

export function generateImportMap(pkgJsonObj: any): ImportMap {
  const imports: Record<string, string> = {};
  if (!pkgJsonObj || typeof pkgJsonObj !== "object") {
    return { imports };
  }

  const allDeps = {
    ...(pkgJsonObj.dependencies || {}),
    ...(pkgJsonObj.devDependencies || {}),
  };

  for (const [pkgName, rawVer] of Object.entries(allDeps)) {
    if (!isValidNpmPackageName(pkgName)) {
      continue;
    }
    const ver = cleanVersionRange(rawVer as string);
    if (!ver) {
      continue;
    }
    imports[pkgName] = `https://esm.sh/${pkgName}@${ver}`;
    imports[`${pkgName}/`] = `https://esm.sh/${pkgName}@${ver}/`;
  }

  return { imports };
}

const MODULE_SCRIPT_RE = /<script\b[^>]*\btype=["']?module["']?[^>]*>/i;

export function hasModuleScript(html: string): boolean {
  MODULE_SCRIPT_RE.lastIndex = 0;
  return MODULE_SCRIPT_RE.test(html);
}

/**
 * `/site/` 會注入 `<base href="/site-assets/.../">`，讓頁面的相對資產（./x.css、./a.png）
 * 能正確指向 preview 資產路由。但 `<base>` 也會連帶影響**只含片段的 URL**：
 *
 *   <a href="#form">        → 被解析成 /site-assets/.../#form  （應該留在本頁）
 *   <form action="#form">   → 表單送出時打到 /site-assets/...   → 404
 *
 * 後果是錨點導覽與表單全部失效，互動式頁面（本頁的「總覽／逐步說明」切換即靠 form）
 * 直接白畫面。query-only（`?x=1`）同理會被帶到資產路徑。
 *
 * 這裡在伺服器端把 fragment-only 與 query-only 的 href/action 改寫成「相對於文件本身」
 * 的絕對路徑，讓它們不再受 `<base>` 影響。頁面本身的相對資產路徑完全不動。
 *
 * 只在確實有注入 `<base>` 時才做；沒有 base 的頁面維持原本語意。
 */
const FRAGMENT_OR_QUERY_ONLY_RE = /^(#[^\s"'<>]*|\?[^\s"'<>]*)$/;

/** 把單一屬性值改成相對文件 URL 的絕對值；不需要改動時回 null。 */
function absolutizeDocumentRelative(value: string, documentPath: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // 只處理 fragment-only（#x）與 query-only（?x=1#y）；其他交給瀏覽器與 base 處理
  if (!FRAGMENT_OR_QUERY_ONLY_RE.test(trimmed)) return null;
  // documentPath 是「含原 query、不含 fragment」的當前文件 URL（例如
  // /site/gitlab/org%2Frepo?f=a.html）。片段直接接在它後面即等同原頁跳轉。
  return documentPath ? `${documentPath}${trimmed}` : trimmed;
}

/**
 * 改寫 fragment-only / query-only 的 href 與 action，使其不受注入的 <base> 影響。
 * 只動這兩個屬性，其餘 HTML 原樣保留。
 */
export function rewriteDocumentRelativeAttrs(html: string, documentPath: string): string {
  return html.replace(
    /(\s(?:href|action)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix: string, quote: string, value: string) => {
      const rewritten = absolutizeDocumentRelative(value, documentPath);
      if (rewritten === null || rewritten === value) return match;
      return `${prefix}${quote}${rewritten}${quote}`;
    }
  );
}

/** fragment-only 的 URL 是否受 <base> 影響；用於決定要不要進改寫。 */
export function hasFragmentsAffectedByBase(html: string): boolean {
  return /(\s(?:href|action)\s*=\s*)(["'])(#[^"']*|\?[^"']*)\2/i.test(html);
}

export function injectPreviewHead(
  html: string,
  baseHref: string,
  importMap?: ImportMap | null
): string {
  const cleanedHtml = html.replace(/<base\b[^>]*\/?>/gi, "");
  const baseTag = `<base href="${baseHref}">`;
  let mapTag = "";

  if (importMap && importMap.imports && Object.keys(importMap.imports).length > 0) {
    const jsonStr = JSON.stringify(importMap, null, 2).replace(/</g, "\\u003c");
    mapTag = `<script type="importmap">\n${jsonStr}\n</script>`;
  }

  const injectedTags = mapTag ? `${baseTag}\n  ${mapTag}` : baseTag;

  MODULE_SCRIPT_RE.lastIndex = 0;
  const scriptModuleMatch = MODULE_SCRIPT_RE.exec(cleanedHtml);
  const headMatch = /(<head\b[^>]*>)/i.exec(cleanedHtml);

  if (scriptModuleMatch && headMatch) {
    const headCloseIndex = cleanedHtml.toLowerCase().indexOf("</head>");
    if (headCloseIndex === -1 || scriptModuleMatch.index < headCloseIndex) {
      const idx = scriptModuleMatch.index;
      return cleanedHtml.slice(0, idx) + `${injectedTags}\n  ` + cleanedHtml.slice(idx);
    }
  }

  if (headMatch) {
    const idx = headMatch.index + headMatch[0].length;
    return cleanedHtml.slice(0, idx) + `\n  ${injectedTags}` + cleanedHtml.slice(idx);
  }

  return `${injectedTags}\n` + cleanedHtml;
}

export function rewriteCssSideEffectImports(code: string): string {
  const lines = code.split("\n");
  let inBlockComment = false;

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes("*/")) {
        inBlockComment = false;
      }
      return line;
    }

    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      return line;
    }

    if (trimmed.startsWith("//")) {
      return line;
    }

    const cssSideEffectRegex = /^(\s*)import\s+(['"])([^'"]+\.css(?:[?#][^'"]*)?)\2(\s*;?.*)$/;
    const match = cssSideEffectRegex.exec(line);
    if (match) {
      const prefix = match[1];
      const quote = match[2];
      const specifier = match[3];
      const suffix = match[4];

      const hasQuery = specifier.includes("?");
      const queryParam = "site_preview_css=1";
      const newSpecifier = hasQuery ? `${specifier}&${queryParam}` : `${specifier}?${queryParam}`;

      return `${prefix}import ${quote}${newSpecifier}${quote}${suffix}`;
    }

    return line;
  });

  return rewritten.join("\n");
}

export function createCssShim(): string {
  return `(function() {
  try {
    var u = new URL(import.meta.url);
    u.searchParams.delete('site_preview_css');
    var targetHref = u.href;
    var links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    var exists = links.some(function(l) {
      return l.href === targetHref || l.getAttribute('href') === targetHref;
    });
    if (!exists) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = targetHref;
      document.head.appendChild(link);
    }
  } catch (e) {
    console.error('[site-preview] CSS shim error:', e);
  }
})();`;
}

export async function readWithPublicFallback<T>(
  readFn: (filePath: string) => Promise<T>,
  filePath: string
): Promise<T> {
  const cleanPath = filePath.replace(/^\/+/, "");
  try {
    return await readFn(cleanPath);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) {
      if (!cleanPath.startsWith("public/")) {
        try {
          return await readFn("public/" + cleanPath);
        } catch (err2) {
          if (!(err2 instanceof ProviderError && err2.status === 404)) {
            throw err2;
          }
        }
      }
      const lower = cleanPath.toLowerCase();
      if (lower === "favicon.ico" || lower === "favicon.svg" || lower === "public/favicon.ico") {
        try {
          return await readFn("public/favicon.svg");
        } catch (err3) {
          if (!(err3 instanceof ProviderError && err3.status === 404)) {
            throw err3;
          }
        }
      }
    }
    throw err;
  }
}

export async function readClosestPackageJson(
  readFn: (filePath: string) => Promise<Buffer | string>,
  filePath: string
): Promise<unknown | null> {
  const cleanPath = (filePath.split(/[?#]/, 1)[0] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  let currentDir = path.posix.dirname(cleanPath);
  if (currentDir === "." || currentDir === "/") {
    currentDir = "";
  }

  while (true) {
    const pkgPath = currentDir ? `${currentDir}/package.json` : "package.json";
    try {
      const raw = await readFn(pkgPath);
      return JSON.parse(raw.toString());
    } catch (err) {
      if (!(err instanceof ProviderError && err.status === 404)) {
        throw err;
      }
    }

    if (!currentDir) {
      return null;
    }

    const parentDir = path.posix.dirname(currentDir);
    currentDir = parentDir === "." || parentDir === "/" ? "" : parentDir;
  }
}

const PKG_JSON_CACHE_TTL_MS = 5 * 60_000;
const pkgJsonCache = new Map<string, { value: unknown | null; exp: number }>();

function packageJsonCacheDir(filePath: string): string {
  const cleanPath = (filePath.split(/[?#]/, 1)[0] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  let currentDir = path.posix.dirname(cleanPath);
  if (currentDir === "." || currentDir === "/") {
    currentDir = "";
  }
  return currentDir;
}

export async function readClosestPackageJsonCached(
  cacheKeyPrefix: string,
  readFn: (filePath: string) => Promise<Buffer | string>,
  filePath: string
): Promise<unknown | null> {
  const key = `${cacheKeyPrefix}|${packageJsonCacheDir(filePath)}`;
  const hit = pkgJsonCache.get(key);
  if (hit && hit.exp > Date.now()) {
    return hit.value;
  }
  const value = await readClosestPackageJson(readFn, filePath);
  pkgJsonCache.set(key, { value, exp: Date.now() + PKG_JSON_CACHE_TTL_MS });
  return value;
}
