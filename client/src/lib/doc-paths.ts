export type HrefKind = "anchor" | "protocol" | "external" | "repo";

/** 正規化 repo 路徑：吃掉 "."、處理 ".."、去掉多餘斜線與開頭斜線。".." 超出根目錄時就停在根目錄。 */
export function normalizeRepoPath(pathStr: string): string {
  const parts = pathStr.split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
    } else {
      stack.push(p);
    }
  }
  return stack.join("/");
}

/**
 * 判斷一個 href/src 屬於哪一類：
 *  - "#..."                        → "anchor"
 *  - "mailto:" / "tel:" / "data:"  → "protocol"
 *  - "http://" / "https://" / "//" → "external"
 *  - 其他                          → "repo"
 */
export function classifyHref(href: string): HrefKind {
  if (href.startsWith("#")) {
    return "anchor";
  }
  if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) {
    return "protocol";
  }
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    return "external";
  }
  return "repo";
}

/**
 * 把一個 repo 類的 href 解析成「以 repo root 為基準的路徑」＋錨點。
 * currentPath 是目前開啟的檔案路徑（例如 "docs/a/b.md"），用來解析相對路徑。
 * "/" 開頭視為 repo root 絕對路徑。
 * 回傳 { path, anchor }，anchor 含 "#"，沒有就是空字串。
 */
export function resolveRepoHref(href: string, currentPath: string): { path: string; anchor: string } {
  const hashIdx = href.indexOf("#");
  const cleanPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const anchor = hashIdx >= 0 ? href.slice(hashIdx) : "";

  let targetPath: string;
  if (cleanPath.startsWith("/")) {
    targetPath = cleanPath;
  } else {
    const parts = currentPath.split("/");
    const currentDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    targetPath = currentDir ? (cleanPath ? `${currentDir}/${cleanPath}` : currentDir) : cleanPath;
  }

  const path = normalizeRepoPath(targetPath);
  return { path, anchor };
}

/** repo 路徑逐段 encodeURIComponent，保留斜線結構。 */
export function encodeRepoPath(repoPath: string): string {
  if (!repoPath) return "";
  return repoPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * 把 repo 路徑轉成可安全放進 markdown 連結目的地的形式。
 * 含空白或 () <> 時用 CommonMark 角括號包住；角括號形式無法表達的 `>` 先 percent-encode。
 */
export function formatLinkDestination(repoPath: string): string {
  const hadAngleClose = repoPath.includes(">");
  const safePath = repoPath.replace(/>/g, "%3E");
  return hadAngleClose || /[\s()<]/.test(safePath) ? `<${safePath}>` : safePath;
}

/** 把文字放進 markdown 的 [] 內時，跳脫會破壞語法的中括號。 */
export function escapeLinkText(text: string): string {
  return text.replace(/[\[\]]/g, "\\$&");
}

/**
 * 還原 marked 對連結目的地做過的 percent-encoding。
 * 檔名裡可能有單獨的 `%`（例如 "a%b.png"），那會讓 decodeURIComponent 丟 URIError，
 * 這種情況回傳原字串，不可讓例外冒出去。
 */
export function safeDecodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/**
 * 組出可讀取 repo 檔案原始內容的 URL。
 * rawBase 例如 "/raw" 或 "/rawt/GRANT"；project 例如 "interagent-io/global-doc"（整個做一次 encodeURIComponent）。
 * repoPath 會先 normalizeRepoPath 再逐段編碼，確保 ".." 不能逃出 repo。
 */
export function buildAssetUrl(rawBase: string, provider: string, project: string, repoPath: string): string {
  const normalized = normalizeRepoPath(repoPath);
  const encodedRepo = encodeRepoPath(normalized);
  const base = rawBase.replace(/\/+$/, "");

  const segments: string[] = [base];
  if (provider) {
    segments.push(encodeURIComponent(provider));
  }
  if (project) {
    segments.push(encodeURIComponent(project));
  }
  if (encodedRepo) {
    segments.push(encodedRepo);
  }
  return segments.join("/");
}

/** 副檔名是不是圖片（png jpg jpeg gif svg webp avif ico，大小寫不拘）。 */
export function isImagePath(repoPath: string): boolean {
  const cleanPath = repoPath.split("?")[0].split("#")[0];
  const lastSlash = cleanPath.lastIndexOf("/");
  const filename = lastSlash >= 0 ? cleanPath.slice(lastSlash + 1) : cleanPath;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx <= 0) return false;
  const ext = filename.slice(dotIdx + 1).toLowerCase();
  const imageExts = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico"]);
  return imageExts.has(ext);
}

/** 拖曳插入編輯區時要產生的 markdown 片段。圖片→ `![名稱](/路徑)`，其他→ `[名稱](/路徑)`。名稱＝去掉副檔名的檔名。 */
export function insertSnippetFor(repoPath: string): string {
  const normalized = normalizeRepoPath(repoPath);
  const fullPath = "/" + normalized;
  const lastSlash = normalized.lastIndexOf("/");
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIdx = filename.lastIndexOf(".");
  const name = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const linkText = escapeLinkText(name);
  const destination = formatLinkDestination(fullPath);

  if (isImagePath(repoPath)) {
    return `![${linkText}](${destination})`;
  }
  return `[${linkText}](${destination})`;
}

/**
 * 把「本站的資產 URL」還原成 repo 相對路徑。
 * 認得的形式（可帶或不帶 origin，也吃 ?download=1 之類 query 與 #hash）：
 *   https://note.ia/raw/<provider>/<project>/<repo/path>
 *   /raw/<provider>/<project>/<repo/path>
 *   /rawt/<grant>/<provider>/<project>/<repo/path>
 *   /api/public/<token>/raw/<provider>/<project>/<repo/path>
 * 給了 origin 時，帶主機名的 URL 必須同源才算數（別把外站的 /raw/... 當成自己的檔案）。
 * 回傳 percent-decode 後的 repo 路徑（不含開頭斜線）；不是本站資產 URL 就回 null。
 *
 * 存在的理由：markdown 原始碼裡絕對不能出現 rawBase／主機名／grant token
 * （grant 90 天會過期，寫進文件就永久壞掉），所以任何來源的資產 URL 都要先還原成相對路徑。
 */
export function repoPathFromAssetUrl(url: string, origin?: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, "http://note.invalid");
  } catch {
    return null;
  }

  const hasHost = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || trimmed.startsWith("//");
  if (hasHost) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (origin && parsed.origin !== origin) return null;
  }

  const segs = parsed.pathname.split("/").filter((s) => s !== "");
  let rest: string[] | null = null;
  if (segs[0] === "raw") {
    rest = segs.slice(1);
  } else if (segs[0] === "rawt" && segs.length > 1) {
    rest = segs.slice(2);
  } else if (segs[0] === "api" && segs[1] === "public" && segs[3] === "raw") {
    rest = segs.slice(4);
  }
  // rest = [<provider>, <project>, ...repo 路徑]，少於三段就不是檔案 URL
  if (!rest || rest.length < 3) return null;

  const repoPath = normalizeRepoPath(rest.slice(2).map(safeDecodeHref).join("/"));
  return repoPath || null;
}

/**
 * 一次拖放要插入的 markdown（純函式版本，給 UI 與測試共用）。
 * 檔案樹的檔案（application/x-note-path）→ 圖片 `![]()`／其他 `[]()`；
 * 本站資產 URL（例如抓著下載 icon 拖出來的 /raw/... 連結）→ 一樣還原成相對路徑嵌入；
 * 外部網址 → 裸網址（預覽會渲染成卡片）。取不到就回 null。
 */
export function snippetFromDragData(
  data: { notePath?: string | null; uriList?: string | null; plain?: string | null },
  origin?: string
): string | null {
  const notePath = (data.notePath || "").trim();
  if (notePath) {
    const fromAsset = repoPathFromAssetUrl(notePath, origin);
    if (fromAsset) return insertSnippetFor(fromAsset);
    if (!isHttpUrl(notePath)) return insertSnippetFor(notePath);
    // payload 竟然是外部網址 → 往下走網址那條路
  }

  const raw = data.uriList || data.plain || "";
  const url =
    raw
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#")) || "";
  if (!url) return null;

  const repoPath = repoPathFromAssetUrl(url, origin);
  if (repoPath) return insertSnippetFor(repoPath);
  return isHttpUrl(url) ? url : null;
}

/**
 * 產生一個「同一個原生 drop 事件只放行一次」的把關函式。
 * <main>、預覽窗格、編輯區三個 handler 都綁在同一棵 DOM 上，冒泡時可能被處理不只一次，
 * 造成同一次拖放插入兩份內容；每個 handler 插入前先問過這個把關函式即可。
 */
export function createDropClaim(): (evt: unknown) => boolean {
  let last: unknown = null;
  return (evt: unknown) => {
    if (evt != null && evt === last) return false;
    last = evt;
    return true;
  };
}

/** 是不是一個 http/https 網址（用於 URL 卡片判定）。 */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 判斷一個連結該不該渲染成「網址卡片」，並回傳卡片要顯示的內容。
 * 條件：href 是 http(s) 網址，且連結文字去空白後等於 href（＝markdown 裡獨立一行的裸網址）。
 * 回傳 { domain, display } 或 null。domain 是主機名（去掉開頭的 "www."），display 是原網址。
 * 這個函式不可以用 `new URL()` 以外的方式解析；`new URL()` 丟例外時回傳 null。
 */
export function urlCardInfo(href: string, linkText: string): { domain: string; display: string } | null {
  if (linkText.trim() !== href.trim()) {
    return null;
  }
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    let domain = url.hostname;
    if (domain.startsWith("www.")) {
      domain = domain.slice(4);
    }
    return {
      domain,
      display: href,
    };
  } catch {
    return null;
  }
}
