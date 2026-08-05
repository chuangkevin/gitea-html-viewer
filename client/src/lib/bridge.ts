export interface BridgeContext {
  iframe: HTMLIFrameElement;
  readFile: (path: string) => Promise<string>;
  saveFile: (path: string, content: string) => Promise<void>;
  openPath: (path: string) => void;
}

/**
 * 驗證請求路徑安全性與合法性：
 * - 必須為字串、非空且長度小於 500 字元
 * - 不得以 '/' 開頭
 * - 不得包含 '..' 或反斜線 '\'
 * - 讀與寫一律只允許 '.md' 副檔名
 */
function isValidPath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length >= 500) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("..") || path.includes("\\")) return false;
  if (!path.toLowerCase().endsWith(".md")) return false;
  return true;
}

/**
 * attachBridge: 為 iframe sandbox HTML 預覽頁面掛載 postMessage 橋接器
 */
export function attachBridge(ctx: BridgeContext): () => void {
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
      const { type, path, content } = data;

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
        if (typeof content !== "string" || content.length >= 2 * 1024 * 1024) {
          postReply({ type: "nb:error", message: "檔案內容必須為字串且大小必須小於 2MB" });
          return;
        }
        await ctx.saveFile(path, content);
        postReply({ type: "nb:saved", path });
      } else if (type === "nb:open") {
        if (!isValidPath(path)) {
          postReply({ type: "nb:error", message: `無效或不允許的檔案路徑：${String(path)}` });
          return;
        }
        ctx.openPath(path);
      }
    } catch (err: any) {
      postReply({ type: "nb:error", message: err?.message || String(err) });
    }
  };

  window.addEventListener("message", handleMessage);
  return () => {
    window.removeEventListener("message", handleMessage);
  };
}
