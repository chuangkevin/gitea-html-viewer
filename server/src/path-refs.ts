export interface ShortLinkTarget {
  provider: string;
  project: string; // 已 decode 的 projectPath
  path: string; // 已 decode 的 repo 內相對路徑
  kind: "file" | "folder";
}

function stripFragment(targetPath: string): string {
  const hash = targetPath.indexOf("#");
  return hash >= 0 ? targetPath.slice(0, hash) : targetPath;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function rawQueryParam(search: string, key: string): string | null {
  if (!search) return null;
  for (const part of search.split("&")) {
    const eq = part.indexOf("=");
    const name = eq >= 0 ? part.slice(0, eq) : part;
    if (name === key) return eq >= 0 ? part.slice(eq + 1) : "";
  }
  return null;
}

/** 從短網址的 target_path 解析出它指向哪個 repo 的哪個路徑。認不出就回 null。
 *  支援兩種形式：
 *    /edit/<provider>/<encodeURIComponent(project)>?f=<enc path>    → kind "file"
 *    /edit/<provider>/<encodeURIComponent(project)>?dir=<enc path>  → kind "folder"
 *    /p/<provider>/<encodeURIComponent(project)>/<path 各段編碼>     → kind "file"
 *  其他形式（/site/、/present/、沒有 f/dir 參數等）一律回 null。 */
export function parseShortLinkTarget(targetPath: string): ShortLinkTarget | null {
  const raw = stripFragment(targetPath);
  const q = raw.indexOf("?");
  const pathname = q >= 0 ? raw.slice(0, q) : raw;
  const search = q >= 0 ? raw.slice(q + 1) : "";

  if (!pathname.startsWith("/")) return null;
  const segments = pathname.split("/");
  // ['', route, provider, encodedProject, ...path]
  if (segments.length < 4 || segments[0] !== "") return null;

  const route = segments[1];
  const provider = segments[2];
  const encodedProject = segments[3];
  if (!route || !provider || !encodedProject) return null;

  const project = safeDecode(encodedProject);
  if (project === null || project === "") return null;

  if (route === "edit") {
    if (segments.length !== 4) return null;
    const f = rawQueryParam(search, "f");
    if (f !== null && f !== "") {
      const filePath = safeDecode(f);
      if (filePath === null || filePath === "") return null;
      return { provider, project, path: filePath, kind: "file" };
    }
    const dir = rawQueryParam(search, "dir");
    if (dir !== null && dir !== "") {
      const dirPath = safeDecode(dir);
      if (dirPath === null || dirPath === "") return null;
      return { provider, project, path: dirPath, kind: "folder" };
    }
    return null;
  }

  if (route === "p") {
    const rest = segments.slice(4);
    if (rest.length === 0 || rest.some((seg) => seg === "")) return null;
    const decoded: string[] = [];
    for (const seg of rest) {
      const part = safeDecode(seg);
      if (part === null) return null;
      decoded.push(part);
    }
    const filePath = decoded.join("/");
    if (!filePath) return null;
    return { provider, project, path: filePath, kind: "file" };
  }

  return null;
}

/** 某個 repo 路徑（file 或 folder）被改名／刪除時，這個 target 會不會受影響。
 *  - changedKind === "file"：target.path === changedPath 才算
 *  - changedKind === "folder"：target.path === changedPath 或以 changedPath + "/" 開頭都算
 *  provider / project 不同一律回 false。 */
export function targetAffectedBy(
  target: ShortLinkTarget,
  provider: string,
  project: string,
  changedPath: string,
  changedKind: "file" | "folder"
): boolean {
  if (target.provider !== provider || target.project !== project) return false;
  return sharePathAffected(target.path, changedPath, changedKind);
}

/** 同樣的比對規則，用在 share 的路徑上（share 沒有 provider 以外的 kind 概念）。 */
export function sharePathAffected(
  sharePath: string,
  changedPath: string,
  changedKind: "file" | "folder"
): boolean {
  if (changedKind === "file") return sharePath === changedPath;
  return sharePath === changedPath || sharePath.startsWith(changedPath + "/");
}
