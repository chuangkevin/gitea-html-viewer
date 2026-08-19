import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const DARK_TEXT = "#0b0b0d";
const LIGHT_TEXT = "#ffffff";
/** 相對亮度中點：高於這個用深字、低於用白字。 */
const LUMINANCE_CUTOFF = 0.5;

/**
 * 純視覺：幫遠端游標的名字標籤選對比色、把疊在一起的標籤往上錯開。
 * 不碰文件內容、不碰 Yjs。
 */
export function presencePolish(): Extension {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private raf = 0;

      constructor(view: EditorView) {
        this.view = view;
        this.schedule();
      }

      update(_update: ViewUpdate) {
        this.schedule();
      }

      destroy() {
        if (this.raf !== 0) {
          cancelAnimationFrame(this.raf);
          this.raf = 0;
        }
      }

      private schedule() {
        if (this.raf !== 0) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          polishPresence(this.view);
        });
      }
    }
  );
}

function polishPresence(view: EditorView) {
  const labels = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-ySelectionInfo"));
  for (const el of labels) {
    el.style.transform = "";
    applyLabelContrast(el);
  }
  stackOverlappingLabels(labels);
}

function applyLabelContrast(el: HTMLElement) {
  const rgb = parseCssColor(backgroundOfInfo(el));
  if (!rgb) return;
  const bright = relativeLuminance(rgb[0], rgb[1], rgb[2]) >= LUMINANCE_CUTOFF;
  if (bright) {
    el.style.color = DARK_TEXT;
    el.style.textShadow = "0 0 1px rgba(255,255,255,.45)";
  } else {
    el.style.color = LIGHT_TEXT;
    el.style.textShadow = "0 0 1px rgba(0,0,0,.65)";
  }
}

/**
 * y-codemirror.next 把 `background-color` 寫在 `.cm-ySelectionCaret` 上，
 * `.cm-ySelectionInfo` 是 CSS inherit，本身通常沒有 inline background。
 */
function backgroundOfInfo(el: HTMLElement): string {
  if (el.style.backgroundColor) return el.style.backgroundColor;
  const parent = el.parentElement;
  if (parent?.style.backgroundColor) return parent.style.backgroundColor;
  return getComputedStyle(el).backgroundColor;
}

function stackOverlappingLabels(labels: HTMLElement[]) {
  const items = labels
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
    })
    .filter((item) => item.height > 0 && item.right > item.left)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  for (let i = 1; i < items.length; i++) {
    const step = items[i].height + 2;
    let shift = 0;
    let bumped = true;
    let guard = 0;
    while (bumped && guard < items.length) {
      bumped = false;
      guard += 1;
      const moved = {
        left: items[i].left,
        right: items[i].right,
        top: items[i].top - shift,
        bottom: items[i].bottom - shift,
      };
      for (let j = 0; j < i; j++) {
        if (rectsOverlap(moved, items[j])) {
          shift += step;
          bumped = true;
          break;
        }
      }
    }
    if (shift > 0) {
      items[i].el.style.transform = `translateY(-${shift}px)`;
      items[i].top -= shift;
      items[i].bottom -= shift;
    }
  }
}

function rectsOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number }
): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function parseCssColor(input: string): [number, number, number] | null {
  const value = input.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
