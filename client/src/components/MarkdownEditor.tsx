import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

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
  /** 捲動同步用的元素（CM 的 scroller，不是最外層容器）。 */
  getScrollDOM(): HTMLElement | null;
}

interface Props {
  value: string;
  onChange(next: string): void;
  onSelectionChange(value: string, cursorPos: number): void;
  /** 回傳 true = 已處理，CM 不要再處理這個鍵（@ 選單導航靠這個）。 */
  onKeyDown(e: KeyboardEvent): boolean;
  onPaste(e: ClipboardEvent): void;
  onDrop(e: DragEvent): void;
  onDragOver(e: DragEvent): void;
  onScroll(scroller: HTMLElement): void;
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
  },
  { dark: true }
);

const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // domEventHandlers / updateListener 會被關進 extension 的 closure 裡，
  // 直接塞 props 會永遠抓到第一次 render 的舊值，所以一律走 ref。
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: cb.current.value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
            drop: (e) => cb.current.onDrop(e),
            dragover: (e) => cb.current.onDragOver(e),
          }),
          noteTheme,
          EditorView.contentAttributes.of({ spellcheck: "false" }),
        ],
      }),
      parent: host,
    });

    viewRef.current = view;

    // scroll 事件不冒泡，掛在 view.dom 或走 domEventHandlers 都收不到，
    // 必須直接掛在真正會捲動的 scroller 上。
    const scroller = view.scrollDOM;
    const onScroll = () => cb.current.onScroll(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

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
      getScrollDOM: () => viewRef.current?.scrollDOM ?? null,
    }),
    []
  );

  return <div ref={hostRef} className={props.className} />;
});

export default MarkdownEditor;
