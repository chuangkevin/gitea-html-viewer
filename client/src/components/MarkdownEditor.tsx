import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { livePreview, type LivePreviewContext } from "../lib/cm-live-preview";
import type { LineBlock } from "../lib/block-insert";

/**
 * Workspace 對編輯器的最小介面。
 * 刻意不外洩 EditorView：Workspace 只需要「游標在哪、放到哪、捲軸是誰」，
 * 這樣之後換底層或加行內渲染都不會牽動 Workspace。
 */
export interface MarkdownEditorHandle {
  getSelectionStart(): number;
  setSelection(pos: number): void;
  focus(): void;
  /** 螢幕座標 → markdown 原始碼 offset。算不出來回 null。 */
  posAtCoords(x: number, y: number): number | null;
  /** 目前視窗內每一行的螢幕位置與原始碼範圍，依畫面順序排列。 */
  lineBlocksInViewport(): LineBlock[];
  /** 捲動同步用的元素（CM 的 scroller，不是最外層容器）。 */
  getScrollDOM(): HTMLElement | null;
}

interface Props {
  value: string;
  onChange(next: string): void;
  onSelectionChange(value: string, cursorPos: number): void;
  /** 回傳 true = 已處理，CM 不要再處理這個鍵（@ 選單導航靠這個）。 */
  onKeyDown(e: KeyboardEvent): boolean;
  /** 回傳 true = 我們處理掉了，CodeMirror 不要再跑它自己的 paste。 */
  onPaste(e: ClipboardEvent): boolean;
  /** 回傳 true = 我們處理掉了，CodeMirror 不要再跑它自己的 drop。 */
  onDrop(e: DragEvent): boolean;
  onDragOver(e: DragEvent): void;
  onScroll(scroller: HTMLElement): void;
  /** 行內渲染要用的連結脈絡（圖片路徑解析）。null = 不渲染圖片。 */
  livePreviewContext: LivePreviewContext | null;
  /** true = 所見即所得（游標行露原文、其餘行渲染）；false = 純 markdown 原始碼。 */
  livePreview: boolean;
  className?: string;
}

/** 跟原本 textarea 的 Tailwind class 對齊：zinc-950 底、等寬、16px/1.75、p-5、無 outline。 */
const noteTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "#09090b",
      color: "#e4e4e7",
      fontSize: "16px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      lineHeight: "1.75",
    },
    ".cm-content": { padding: "20px", caretColor: "#f4f4f5" },
    ".cm-line": { padding: "0" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#f4f4f5" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#27272a",
    },
    ".cm-cursor": { borderLeftWidth: "2px" },

    // ── 行內渲染（live preview）的樣式 ──
    // 只改外觀，不改文件內容；游標移到該行時 cm-live-preview 會把裝飾拿掉。
    ".cm-nb-h": { fontWeight: "700", lineHeight: "1.35", color: "#fafafa" },
    ".cm-nb-h1": { fontSize: "1.9em", marginTop: "0.6em", marginBottom: "0.2em" },
    ".cm-nb-h2": { fontSize: "1.55em", marginTop: "0.55em", marginBottom: "0.2em" },
    ".cm-nb-h3": { fontSize: "1.3em", marginTop: "0.5em", marginBottom: "0.15em" },
    ".cm-nb-h4": { fontSize: "1.15em", marginTop: "0.45em" },
    ".cm-nb-h5": { fontSize: "1.05em" },
    ".cm-nb-h6": { fontSize: "1em", color: "#a1a1aa" },
    ".cm-nb-strong": { fontWeight: "700", color: "#fafafa" },
    ".cm-nb-em": { fontStyle: "italic" },
    ".cm-nb-strike": { textDecoration: "line-through", opacity: "0.65" },
    ".cm-nb-inline-code": {
      backgroundColor: "#27272a",
      borderRadius: "4px",
      padding: "0.1em 0.35em",
      color: "#fbbf24",
    },
    ".cm-nb-link": { color: "#38bdf8", textDecoration: "underline" },
    ".cm-nb-listmark": { color: "#38bdf8" },
    ".cm-nb-tabledelim": { color: "#52525b" },
    ".cm-nb-quote": {
      borderLeft: "3px solid #3f3f46",
      paddingLeft: "0.85em",
      color: "#a1a1aa",
      fontStyle: "italic",
    },
    // 只給底色，**不要動 font-size**：CodeMirror 用高度圖決定虛擬捲動，
    // 行內裝飾一旦改變行高，長文件（例如上千行的程式碼區塊）就會算錯高度，
    // 捲到中段會出現大片空白。實測 customers.md（1993 行）就是這樣破的。
    ".cm-nb-code": { backgroundColor: "#18181b" },
    ".cm-nb-img": { display: "inline-block", maxWidth: "100%", verticalAlign: "top" },
    // 圖片不可以撐破窄畫面——RWD 的硬性要求
    ".cm-nb-img img": {
      display: "block",
      maxWidth: "100%",
      height: "auto",
      borderRadius: "6px",
      border: "1px solid #27272a",
    },
    ".cm-nb-hr": {
      display: "inline-block",
      width: "100%",
      borderTop: "2px solid #3f3f46",
      verticalAlign: "middle",
    },
  },
  { dark: true }
);

const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const liveCompartmentRef = useRef(new Compartment());

  // domEventHandlers / updateListener 會被關進 extension 的 closure 裡，
  // 直接塞 props 會永遠抓到第一次 render 的舊值，所以一律走 ref。
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const liveCompartment = liveCompartmentRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: cb.current.value,
        extensions: [
          history(),
          drawSelection(),
          dropCursor(), // 拖曳時顯示落點游標＝落點指示
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // 用 Compartment 才能在不重建 EditorView 的情況下切換行內渲染——
          // 重建會掉游標位置與 undo 歷史。
          liveCompartment.of(
            cb.current.livePreview ? livePreview(() => cb.current.livePreviewContext) : []
          ),
          // Cmd/Ctrl+S 不在這裡綁：Workspace 已有 window keydown 的存檔處理，
          // CM 的 keydown 會冒泡上去。兩邊都綁會存兩次。
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) {
              cb.current.onSelectionChange(u.state.doc.toString(), u.state.selection.main.head);
            }
          }),
          EditorView.domEventHandlers({
            keydown: (e) => cb.current.onKeyDown(e),
            paste: (e) => cb.current.onPaste(e),
          }),
          noteTheme,
          EditorView.contentAttributes.of({ spellcheck: "false" }),
        ],
      }),
      parent: host,
    });

    viewRef.current = view;

    const onHostDragEnter = (e: DragEvent) => cb.current.onDragOver(e);
    const onHostDragOver = (e: DragEvent) => cb.current.onDragOver(e);
    const onHostDrop = (e: DragEvent) => cb.current.onDrop(e);
    const onHostDragLeave = () => {};
    const dragOptions = { capture: true };
    host.addEventListener("dragenter", onHostDragEnter, dragOptions);
    host.addEventListener("dragover", onHostDragOver, dragOptions);
    host.addEventListener("drop", onHostDrop, dragOptions);
    host.addEventListener("dragleave", onHostDragLeave, dragOptions);

    // scroll 事件不冒泡，掛在 view.dom 或走 domEventHandlers 都收不到，
    // 必須直接掛在真正會捲動的 scroller 上。
    const scroller = view.scrollDOM;
    const onScroll = () => cb.current.onScroll(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      host.removeEventListener("dragenter", onHostDragEnter, dragOptions);
      host.removeEventListener("dragover", onHostDragOver, dragOptions);
      host.removeEventListener("drop", onHostDrop, dragOptions);
      host.removeEventListener("dragleave", onHostDragLeave, dragOptions);
      scroller.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 切換「所見即所得 / 原始碼」時只 reconfigure 那個 compartment，view 不重建。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // 關掉行內渲染時圖片 widget 會消失、文件高度驟縮，scrollTop 被夾回 0，
    // 使用者就「掉了看的位置」。所以先記下「現在視窗最上緣是文件的哪個位置」，
    // 切換後再把那個位置捲回最上緣。用視窗頂端而不是游標——使用者可能根本
    // 還沒點過任何地方（游標在 0），那樣會直接跳回文件開頭。
    const box = view.scrollDOM.getBoundingClientRect();
    const anchor =
      view.posAtCoords({ x: box.left + 8, y: box.top + 8 }) ?? view.state.selection.main.head;

    view.dispatch({
      effects: [
        liveCompartmentRef.current.reconfigure(
          props.livePreview ? livePreview(() => cb.current.livePreviewContext) : []
        ),
        EditorView.scrollIntoView(anchor, { y: "start" }),
      ],
    });
  }, [props.livePreview]);

  // 受控同步：只有外部帶進來的 value 跟 CM 目前內容不同才覆寫。
  // 少了這個判斷，使用者自己打的字會被自己的 onChange 再 dispatch 一次，游標會跳。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      getSelectionStart: () => viewRef.current?.state.selection.main.head ?? 0,
      setSelection: (pos) => {
        const view = viewRef.current;
        if (!view) return;
        const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
        view.dispatch({ selection: { anchor: clamped }, scrollIntoView: true });
      },
      focus: () => viewRef.current?.focus(),
      posAtCoords: (x, y) => viewRef.current?.posAtCoords({ x, y }) ?? null,
      lineBlocksInViewport: () => {
        const view = viewRef.current;
        if (!view) return [];
        const blocks = view.viewportLineBlocks;
        if (blocks.length === 0) return [];

        // BlockInfo.top 是「文件座標」。用 documentTop 相加換算成螢幕座標會漏掉
        // .cm-content 的內距與第一行的 margin——實測差 38px，比一個行高（28px）
        // 還多，落點就會整整偏一行。所以直接讀真正渲染出來的 .cm-line 螢幕位置：
        // CodeMirror 對 viewport 內每一行剛好渲染一個 .cm-line，順序一致。
        const lineEls = view.contentDOM.querySelectorAll(".cm-line");
        if (lineEls.length === blocks.length) {
          return blocks.map((b, i) => {
            const r = lineEls[i].getBoundingClientRect();
            return { from: b.from, to: b.to, top: r.top, bottom: r.bottom };
          });
        }

        // 數量對不上（理論上不該發生）才退回幾何換算，並用實際量到的第一行位置校正。
        const probe = view.coordsAtPos(blocks[0].from);
        const delta = probe ? probe.top - blocks[0].top : view.documentTop;
        return blocks.map((b) => ({
          from: b.from,
          to: b.to,
          top: b.top + delta,
          bottom: b.top + b.height + delta,
        }));
      },
      getScrollDOM: () => viewRef.current?.scrollDOM ?? null,
    }),
    []
  );

  return <div ref={hostRef} className={props.className} />;
});

export default MarkdownEditor;
