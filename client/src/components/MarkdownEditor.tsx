import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { livePreview, type LivePreviewContext } from "../lib/cm-live-preview";
import { minimalEdit, type TextEdit } from "../lib/text-diff";

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
  /** 目前編輯器裡的原始碼。 */
  getValue(): string;
  /** 套用一組局部變更；不動範圍外的文字。selection 給了就一起設游標。 */
  applyChanges(changes: TextEdit[], opts?: { selection?: number; scrollIntoView?: boolean }): void;
  /** 在 pos 插入文字。 */
  insertAt(pos: number, text: string, opts?: { selection?: number; scrollIntoView?: boolean }): void;
  /** 把 [from, to) 換成 text。 */
  replaceRange(from: number, to: number, text: string, opts?: { selection?: number; scrollIntoView?: boolean }): void;
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
  /** 有值＝這份文件正在共筆：文件內容以 Y.Text 為準，不再走受控同步。 */
  collab?: {
    text: Y.Text;
    awareness: Awareness;
    undoManager: Y.UndoManager;
  } | null;
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

    // ── 遠端游標（y-codemirror.next）；顏色由 inline style 帶入，這裡只定形狀 ──
    ".cm-ySelection": {},
    ".cm-ySelectionCaret": {
      position: "relative",
      borderLeft: "2px solid",
      borderRight: "none",
      marginLeft: "-1px",
      marginRight: "-1px",
      boxSizing: "border-box",
    },
    ".cm-ySelectionInfo": {
      position: "absolute",
      bottom: "100%",
      left: "0",
      fontSize: "11px",
      lineHeight: "1.3",
      borderRadius: "4px",
      padding: "2px 6px",
      zIndex: "101",
      whiteSpace: "nowrap",
      maxWidth: "min(12rem, 40vw)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      pointerEvents: "none",
      opacity: "1",
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
    const collab = cb.current.collab;
    const view = new EditorView({
      state: EditorState.create({
        doc: collab ? collab.text.toString() : cb.current.value,
        extensions: [
          collab
            ? yCollab(collab.text, collab.awareness, { undoManager: collab.undoManager })
            : history(),
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
          keymap.of(
            collab
              ? [...defaultKeymap, ...yUndoManagerKeymap]
              : [...defaultKeymap, ...historyKeymap]
          ),
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
            // dragover 一定要回傳 falsy：CM 的 dropCursor（落點游標）是靠它自己的
            // dragover handler 更新的，回傳 true 會把落點指示整個擋掉。
            dragover: (e) => {
              cb.current.onDragOver(e);
              return false;
            },
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

  // 受控同步：外部 value 與 CM 目前內容不同時，只替換真正有變的那一段。
  // 整份刪掉重插會讓游標跳掉、undo 歷史被壓平，之後接 Yjs 即時共筆也會炸掉其他人的畫面。
  useEffect(() => {
    if (props.collab) return; // 共筆時 Y.Text 才是真相，不可以再從 props.value 灌
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    const edit = minimalEdit(current, props.value);
    if (!edit) return;
    view.dispatch({ changes: edit });
  }, [props.value, props.collab]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => {
      const applyChanges = (
        changes: TextEdit[],
        opts?: { selection?: number; scrollIntoView?: boolean }
      ) => {
        const view = viewRef.current;
        if (!view) return;
        if (changes.length === 0) return;
        const docLen = view.state.doc.length;
        const clamped: TextEdit[] = [];
        let newLen = docLen;
        for (const change of changes) {
          const from = Math.max(0, Math.min(change.from, docLen));
          const to = Math.max(0, Math.min(change.to, docLen));
          if (to < from) return;
          clamped.push({ from, to, insert: change.insert });
          newLen += change.insert.length - (to - from);
        }
        const spec: {
          changes: TextEdit[];
          selection?: { anchor: number };
          scrollIntoView?: boolean;
        } = { changes: clamped };
        if (opts?.selection !== undefined) {
          spec.selection = { anchor: Math.max(0, Math.min(opts.selection, newLen)) };
        }
        if (opts?.scrollIntoView) spec.scrollIntoView = true;
        view.dispatch(spec);
      };

      return {
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
        getValue: () => viewRef.current?.state.doc.toString() ?? "",
        applyChanges,
        insertAt: (pos, text, opts) => applyChanges([{ from: pos, to: pos, insert: text }], opts),
        replaceRange: (from, to, text, opts) =>
          applyChanges([{ from, to, insert: text }], opts),
      };
    },
    []
  );

  return <div ref={hostRef} className={props.className} />;
});

export default MarkdownEditor;
