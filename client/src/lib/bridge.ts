/**
 * postMessage 橋接器 (iframe ↔ parent) 訊息協定說明：
 *
 * Iframe -> Parent (請求):
 * - { type: 'nb:load', path: string }
 * - { type: 'nb:save', path: string, content: string }
 * - { type: 'nb:open', path: string }
 * - { type: 'nb:list', path: string, recursive?: boolean }
 * - { type: 'nb:whoami' }
 *
 * Parent -> Iframe (回應/通知):
 * - { type: 'nb:ready', version: string }
 * - { type: 'nb:file', path: string, content: string }
 * - { type: 'nb:queued', path: string, jobId: string }   寫入已排入佇列（立刻回，不等 commit）
 * - { type: 'nb:saved', path: string }
 * - { type: 'nb:conflict', path: string, conflicts: Array<{path, currentSha}> }  遠端已改過，你的內容被保留、未覆蓋
 * - { type: 'nb:error', message: string }
 * - { type: 'nb:file-list', path: string, files: Array<{ name, path, size?, isDir, depth? }> }
 * - { type: 'nb:whoami-result', name: string, source: 'oauth' | 'identity' | 'anonymous' }
 */

export interface BridgeContext {
  iframe: HTMLIFrameElement;
  readFile: (path: string) => Promise<string>;
  /** 排入寫入佇列；立刻回 jobId，不等待上游 commit。 */
  saveFile: (path: string, content?: string, contentBase64?: string) => Promise<{ jobId: string }>;
  /** 追蹤剛剛排入的寫入，直到落地、衝突或失敗。 */
  saveResult: (jobId: string) => Promise<{
    status: "done" | "conflict" | "error";
    message?: string;
    conflicts?: { path: string; currentSha: string }[];
  }>;
  openPath: (path: string) => void;
  listFiles: (
    path: string,
    recursive?: boolean
  ) => Promise<Array<{ name: string; path: string; size?: number; isDir: boolean; depth?: number }>>;
  whoami: () => Promise<{ name: string; source: "oauth" | "identity" | "anonymous" }>;
}

/**
 * 驗證檔案路徑安全性與合法性：
 * - 必須為字串、非空且長度小於 500 字元
 * - 不得以 '/' 開頭
 * - 不得包含 '..' 或反斜線 '\'
 * - 任一路徑段不可為空或為 '.' / '..'
 */
function isValidPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length >= 500) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("..") || path.includes("\\")) return false;
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/**
 * 驗證資料夾路徑安全性與合法性：
 * - 必須為字串、非空且長度小於 500 字元
 * - 不得以 '/' 開頭
 * - 不得包含 '..' 或反斜線 '\'
 */
function isValidFolderPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length >= 500) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("..") || path.includes("\\")) return false;
  return true;
}

/**
 * attachBridge: 為 iframe sandbox HTML 預覽頁面掛載 postMessage 橋接器
 */
export function attachBridge(ctx: BridgeContext): () => void {
  const sendReady = () => {
    ctx.iframe.contentWindow?.postMessage({ type: "nb:ready", version: __APP_VERSION__ }, "*");
  };

  const handleMessage = async (e: MessageEvent) => {
    // 唯一信任依據是 e.source === ctx.iframe.contentWindow
    // （opaque origin 的 e.origin 是 'null'，不可用作來源驗證）
    if (!e.source || e.source !== ctx.iframe.contentWindow) {
      return;
    }

    const postReply = (msg: unknown) => {
      // 對 opaque origin 回覆訊息時 targetOrigin 只能帶 '*'，
      // 安全性由上方 e.source === ctx.iframe.contentWindow 比對與權限驗證雙重保證
      ctx.iframe.contentWindow?.postMessage(msg, "*");
    };

    try {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      const { type, path, content, contentBase64 } = data;

      if (type === "nb:load") {
        if (!isValidPath(path)) {
          postReply({ type: "nb:error", message: `無效或不允許的檔案路徑：${String(path)}` });
          return;
        }
        const fileContent = await ctx.readFile(path);
        postReply({ type: "nb:file", path, content: fileContent });
      } else if (type === "nb:save") {
        if (!isValidPath(path)) {
          postReply({ type: "nb:error", message: `無效或不允許的檔案路徑：${String(path)}` });
          return;
        }
        if (typeof contentBase64 !== "string" && typeof content !== "string") {
          postReply({ type: "nb:error", message: "檔案內容 (content 或 contentBase64) 為必填" });
          return;
        }
        if (typeof content === "string" && content.length >= 20 * 1024 * 1024) {
          postReply({ type: "nb:error", message: "檔案內容必須小於 20MB" });
          return;
        }
        const { jobId } = await ctx.saveFile(
          path,
          typeof content === "string" ? content : undefined,
          typeof contentBase64 === "string" ? contentBase64 : undefined
        );
        // 立刻回「已排入」：頁面不必等上游 commit。
        postReply({ type: "nb:queued", path, jobId });
        // 落地結果非同步補送，讓頁面能顯示已儲存／衝突／失敗。
        void ctx
          .saveResult(jobId)
          .then((res) => {
            if (res.status === "done") {
              postReply({ type: "nb:saved", path, jobId });
            } else if (res.status === "conflict") {
              postReply({ type: "nb:conflict", path, jobId, conflicts: res.conflicts ?? [] });
            } else {
              postReply({ type: "nb:error", path, jobId, message: res.message ?? "儲存失敗" });
            }
          })
          .catch((err: unknown) => {
            postReply({ type: "nb:error", path, jobId, message: (err as Error)?.message || String(err) });
          });
      } else if (type === "nb:open") {
        if (!isValidPath(path)) {
          postReply({ type: "nb:error", message: `無效或不允許的檔案路徑：${String(path)}` });
          return;
        }
        ctx.openPath(path);
      } else if (type === "nb:list") {
        if (!isValidFolderPath(path)) {
          postReply({ type: "nb:error", message: `無效或不允許的資料夾路徑：${String(path)}` });
          return;
        }
        const recursive = Boolean(data.recursive);
        const files = await ctx.listFiles(path, recursive);
        postReply({ type: "nb:file-list", path, files });
      } else if (type === "nb:whoami") {
        try {
          const res = await ctx.whoami();
          const name = typeof res?.name === "string" ? res.name : "";
          const source =
            res?.source === "oauth" || res?.source === "identity" ? res.source : "anonymous";
          postReply({ type: "nb:whoami-result", name: source === "anonymous" ? "" : name, source });
        } catch {
          postReply({ type: "nb:whoami-result", name: "", source: "anonymous" });
        }
      }
    } catch (err: any) {
      postReply({ type: "nb:error", message: err?.message || String(err) });
    }
  };

  window.addEventListener("message", handleMessage);
  sendReady();
  ctx.iframe.addEventListener("load", sendReady);

  return () => {
    window.removeEventListener("message", handleMessage);
    ctx.iframe.removeEventListener("load", sendReady);
  };
}
