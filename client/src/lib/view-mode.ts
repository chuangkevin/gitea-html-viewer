export type ViewMode = "edit" | "split" | "preview";

export const VIEW_MODE_STORAGE_KEY = "note.viewMode";

export function isViewMode(v: unknown): v is ViewMode {
  return v === "edit" || v === "split" || v === "preview";
}

export function defaultViewMode(isDesktop: boolean): ViewMode {
  return isDesktop ? "split" : "edit";
}

export function initialViewMode(stored: string | null, isDesktop: boolean): ViewMode {
  return isViewMode(stored) ? stored : defaultViewMode(isDesktop);
}

export function resolveViewMode(
  view: ViewMode,
  opts: { readOnly: boolean; isDesktop: boolean }
): ViewMode {
  if (opts.readOnly) return "preview";
  if (!opts.isDesktop && view === "split") return "edit";
  return view;
}
