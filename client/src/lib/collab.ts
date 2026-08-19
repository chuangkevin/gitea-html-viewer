import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

export interface CollabUser {
  name: string;
  color: string;
}

export interface CollabSession {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  undoManager: Y.UndoManager;
  destroy(): void;
}

/** 目前這個網站的 WebSocket 起點（http→ws、https→wss）。 */
export function collabServerUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

/** 開一條共筆連線。docKey 就是 Workspace 的 editorDocKey。 */
export function createCollabSession(docKey: string, user: CollabUser): CollabSession {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const provider = new WebsocketProvider(collabServerUrl(), "collab", doc, {
    params: { doc: docKey },
    disableBc: true,
  });
  const undoManager = new Y.UndoManager(text);
  provider.awareness.setLocalStateField("user", { name: user.name, color: user.color });
  let destroyed = false;
  return {
    doc,
    text,
    provider,
    undoManager,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      provider.awareness.destroy?.();
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}
