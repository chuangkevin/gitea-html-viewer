import { type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildAssetUrl, classifyHref, resolveRepoHref, safeDecodeHref } from "./doc-paths.js";

/**
 * 行內渲染（live preview）：把 markdown 語法符號藏起來、套上該有的樣式，
 * 游標所在的那幾行則還原成可編輯的原文。
 *
 * 這一層**只負責定位與外觀**，不產生 HTML、不改文件內容——
 * markdown 原文永遠是唯一真相。真正的渲染仍然是預覽窗格的 marked，
 * 兩邊不會變成兩套規則。唯一會產生視覺內容的是圖片，它的 URL 走
 * doc-paths 的同一組函式（跟 markdown.ts 共用），所以相對路徑／角括號
 * ／raw 資產 URL 的規則只有一份。
 */
export interface LivePreviewContext {
  provider: string;
  project: string;
  /** 目前開啟的檔案路徑，用來解析相對路徑 */
  currentPath: string;
  rawBase: string;
}

/** 圖片：直接畫出 <img>，而不是顯示 `![alt](path)` 原文。 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-nb-img";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.loading = "lazy";
    wrap.appendChild(img);
    return wrap;
  }

  /** 讓 CM 知道這個 widget 高度會變（圖片載入後），需要重新量測。 */
  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-nb-hr";
    return el;
  }
}

const HEADING_RE = /^ATXHeading(\d)$/;

/** 把 markdown 裡的圖片路徑換成真的載得到的 URL。外部連結原樣用。 */
export function imageSrc(rawUrl: string, ctx: LivePreviewContext | null): string | null {
  let href = rawUrl.trim();
  // 角括號形式 `<path with space.png>`：doc-paths 產出的就是這種，要先剝掉
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  if (!href) return null;

  const kind = classifyHref(href);
  if (kind === "external" || kind === "protocol") return href;
  if (kind === "anchor") return null;
  if (!ctx) return null;

  const { path } = resolveRepoHref(safeDecodeHref(href), ctx.currentPath);
  if (!path) return null;
  return buildAssetUrl(ctx.rawBase, ctx.provider, ctx.project, path);
}

const hidden = Decoration.replace({});

interface BuiltDecorations {
  decorations: DecorationSet;
  /** 只含圖片 widget 的範圍：註冊成 atomicRanges，游標會停在圖片前後而不是跑進去。 */
  atomic: DecorationSet;
}

function buildDecorations(view: EditorView, ctx: LivePreviewContext | null): BuiltDecorations {
  const marks: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const { state } = view;

  // 游標（或選取範圍）碰到的行：這些行要顯示原文，不做任何隱藏。
  const activeLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) activeLines.add(n);
  }
  const lineActive = (pos: number) => activeLines.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const active = lineActive(node.from);

        const heading = HEADING_RE.exec(name);
        if (heading) {
          marks.push(
            Decoration.line({ class: `cm-nb-h cm-nb-h${heading[1]}` }).range(
              state.doc.lineAt(node.from).from
            )
          );
          return;
        }

        if (name === "Blockquote") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            marks.push(Decoration.line({ class: "cm-nb-quote" }).range(state.doc.line(n).from));
          }
          return;
        }

        if (name === "FencedCode") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            marks.push(Decoration.line({ class: "cm-nb-code" }).range(state.doc.line(n).from));
          }
          return;
        }

        if (name === "Image") {
          // 圖片是 block 級 widget，**不套用「游標所在行露出原文」那條規則**——
          // 點一下圖片就變回 ![](...) 文字是不能接受的。
          //
          // 唯一的例外：游標「嚴格落在語法內部」，代表使用者正在手打 ![](路徑)，
          // 這時要讓他看得到自己在打什麼。因為圖片是 atomic 的，用滑鼠點只會把
          // 游標放在圖片前或後（邊界不算內部），所以點擊永遠不會把圖變成文字。
          const sel = state.selection.main;
          if (sel.from > node.from && sel.to < node.to) return;

          const urlNode = node.node.getChild("URL");
          if (!urlNode) return;
          const src = imageSrc(state.sliceDoc(urlNode.from, urlNode.to), ctx);
          if (!src) return;
          // alt = `![` 與 `]` 之間那段
          const open = node.node.getChild("LinkMark");
          const alt = open ? state.sliceDoc(open.to, Math.max(open.to, urlNode.from - 2)).replace(/[\]([]/g, "").trim() : "";
          const imageDeco = Decoration.replace({ widget: new ImageWidget(src, alt) });
          marks.push(imageDeco.range(node.from, node.to));
          // 讓整張圖成為一個不可進入的單位：方向鍵會跳過它，Backspace 會整段刪掉
          atomicRanges.push(imageDeco.range(node.from, node.to));
          return false; // 整個節點被取代了，不用再看子節點
        }

        if (name === "HorizontalRule" && !active) {
          marks.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
          return false;
        }

        if (name === "StrongEmphasis") {
          marks.push(Decoration.mark({ class: "cm-nb-strong" }).range(node.from, node.to));
          return;
        }
        if (name === "Emphasis") {
          marks.push(Decoration.mark({ class: "cm-nb-em" }).range(node.from, node.to));
          return;
        }
        if (name === "Strikethrough") {
          marks.push(Decoration.mark({ class: "cm-nb-strike" }).range(node.from, node.to));
          return;
        }
        if (name === "InlineCode") {
          marks.push(Decoration.mark({ class: "cm-nb-inline-code" }).range(node.from, node.to));
          return;
        }
        if (name === "Link") {
          marks.push(Decoration.mark({ class: "cm-nb-link" }).range(node.from, node.to));
          return;
        }
        if (name === "ListMark") {
          marks.push(Decoration.mark({ class: "cm-nb-listmark" }).range(node.from, node.to));
          return;
        }
        if (name === "TableDelimiter") {
          marks.push(Decoration.mark({ class: "cm-nb-tabledelim" }).range(node.from, node.to));
          return;
        }

        // ── 以下是「藏起來的語法符號」，游標在該行時一律不藏 ──
        if (active) return;

        if (name === "HeaderMark" || name === "QuoteMark") {
          // 連同後面那個空白一起藏，文字才不會往右縮排
          const end = state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          marks.push(hidden.range(node.from, end));
          return;
        }

        if (name === "EmphasisMark" || name === "StrikethroughMark" || name === "CodeMark") {
          marks.push(hidden.range(node.from, node.to));
          return;
        }

        // 連結：藏掉 `[` `]` `(` `)` 與 URL，只留看得懂的文字
        if (name === "URL" || name === "LinkTitle") {
          const parent = node.node.parent?.name;
          if (parent === "Link") marks.push(hidden.range(node.from, node.to));
          return;
        }
        if (name === "LinkMark" && node.node.parent?.name === "Link") {
          marks.push(hidden.range(node.from, node.to));
          return;
        }
      },
    });
  }

  return {
    decorations: Decoration.set(marks, true),
    atomic: Decoration.set(atomicRanges, true),
  };
}

/**
 * @param getContext 回傳目前檔案的連結脈絡。用 function 是因為使用者會換檔，
 *                   extension 建立當下的值會過期。
 */
export function livePreview(getContext: () => LivePreviewContext | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;

      constructor(view: EditorView) {
        const built = buildDecorations(view, getContext());
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }

      update(update: ViewUpdate) {
        // 選取範圍變動也要重算：游標移到哪一行，那行的 inline 格式就要還原成原文
        // （圖片不在此列——它永遠是圖）
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          const built = buildDecorations(update.view, getContext());
          this.decorations = built.decorations;
          this.atomic = built.atomic;
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    }
  );
}
