import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { collabColorIndex, pickCollabColor } from "./collab-color.js";

export { COLLAB_PALETTE, collabColorIndex, pickCollabColor } from "./collab-color.js";

export interface CollabUser {
  name: string;
  color: string;
}

export interface CollabSession {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  undoManager: Y.UndoManager;
  /** server snapshot 回 git 的時間戳（毫秒）；還沒存過是 null。 */
  meta: Y.Map<unknown>;
  destroy(): void;
}

/** 目前這個網站的 WebSocket 起點（http→ws、https→wss）。 */
export function collabServerUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function takenColors(provider: WebsocketProvider, myClientId: number): string[] {
  const taken: string[] = [];
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId === myClientId) return;
    const color = state.user?.color;
    if (typeof color === "string") taken.push(color);
  });
  return taken;
}

function applyLocalUserColor(provider: WebsocketProvider, name: string): void {
  const myClientId = provider.awareness.doc.clientID;
  const color = pickCollabColor(collabColorIndex(name), takenColors(provider, myClientId));
  const current = provider.awareness.getLocalState()?.user;
  if (current?.name === name && current?.color === color && current?.colorLight === color + "40") {
    return;
  }
  provider.awareness.setLocalStateField("user", {
    name,
    color,
    colorLight: color + "40",
  });
}

function collidesWithSmallerClient(provider: WebsocketProvider): boolean {
  const myClientId = provider.awareness.doc.clientID;
  const myColor = provider.awareness.getLocalState()?.user?.color;
  if (typeof myColor !== "string") return false;
  let collided = false;
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId >= myClientId) return;
    if (state.user?.color === myColor) collided = true;
  });
  return collided;
}

/** 開一條共筆連線。docKey 就是 Workspace 的 editorDocKey。 */
export function createCollabSession(docKey: string, user: CollabUser): CollabSession {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const meta = doc.getMap("meta");
  const provider = new WebsocketProvider(collabServerUrl(), "collab", doc, {
    params: { doc: docKey },
    disableBc: true,
  });
  const undoManager = new Y.UndoManager(text);
  applyLocalUserColor(provider, user.name);
  const onAwarenessChange = () => {
    if (collidesWithSmallerClient(provider)) applyLocalUserColor(provider, user.name);
  };
  provider.awareness.on("change", onAwarenessChange);
  let destroyed = false;
  return {
    doc,
    text,
    provider,
    undoManager,
    meta,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      provider.awareness.off("change", onAwarenessChange);
      provider.awareness.destroy?.();
      undoManager.destroy();
      provider.destroy();
      doc.destroy();
    },
  };
}
