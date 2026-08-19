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
}): string {
  const { provider, project, folderPath = "", grant } = opts;
  const cleanFolder = encodeFolderPath(folderPath);
  const encodedProject = encodeURIComponent(project);
  if (grant) {
    return `/site-assetst/${encodeURIComponent(grant)}/${provider}/${encodedProject}/${cleanFolder}`;
  }
  return `/site-assets/${provider}/${encodedProject}/${cleanFolder}`;
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
