import { useEffect, useMemo, useRef, useState } from "react";

/** VS Code 風格巢狀檔案樹。展示模式（presentMode）時每列多一個 checkbox，
 *  勾資料夾＝勾整個子樹；勾選集合的順序一律取「資料夾排序」（此樹的顯示順序）。 */

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[] | null; // null = 檔案
}

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      const isFile = i === parts.length - 1;
      let node = level.find((n) => n.name === parts[i] && (n.children === null) === isFile);
      if (!node) {
        node = { name: parts[i], path: acc, children: isFile ? null : [] };
        level.push(node);
      }
      if (!isFile) level = node.children!;
    }
  }
  const sortLevel = (nodes: TreeNode[]) => {
    // 資料夾在前、再按名稱——與 VS Code 的資料夾排序一致
    nodes.sort((a, b) => {
      if ((a.children === null) !== (b.children === null)) return a.children === null ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    for (const n of nodes) if (n.children) sortLevel(n.children);
  };
  sortLevel(root);
  return root;
}

/** 樹的顯示順序攤平成檔案清單——連續模式與展示集的播放順序來源。 */
export function flattenFiles(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.children) walk(n.children);
      else out.push(n.path);
    }
  };
  walk(nodes);
  return out;
}

function subtreeFiles(node: TreeNode): string[] {
  return node.children ? flattenFiles(node.children) : [node.path];
}

export function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "📝";
  if (ext === "html" || ext === "htm") return "🌐";
  if (ext === "css") return "🎨";
  if (["js", "mjs", "ts", "jsx", "tsx"].includes(ext)) return "⚙️";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "📦";
  return "📄";
}

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="bg-sky-800/60 text-sky-200 rounded px-0.5 font-semibold">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

interface Props {
  paths: string[];
  activePath: string;
  activeFolder: string;
  onSelectFile: (path: string) => void;
  onSelectFolder: (path: string) => void;
  presentMode: boolean;
  checked: Set<string>;
  onCheckedChange: (next: Set<string>) => void;
  rawBase?: string;
  refPath?: string;
  /** 把某個檔案插入編輯區（拖曳或按「＋」鈕）。不給就不顯示插入鈕、也不開啟拖曳。 */
  onInsertFile?: (path: string) => void;
}

export default function FileTree({
  paths,
  activePath,
  activeFolder,
  onSelectFile,
  onSelectFolder,
  presentMode,
  checked,
  onCheckedChange,
  rawBase,
  refPath,
  onInsertFile,
}: Props) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");

  const matchingPaths = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return paths.filter((p) => p.toLowerCase().includes(q));
  }, [paths, searchQuery]);

  // 開啟中的檔案：自動展開其所有上層資料夾
  useEffect(() => {
    if (!activePath.includes("/")) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = activePath.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc);
      }
      return next;
    });
  }, [activePath]);

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleCheck = (files: string[], on: boolean) => {
    const next = new Set(checked);
    for (const f of files) {
      if (on) next.add(f);
      else next.delete(f);
    }
    onCheckedChange(next);
  };

  const renderNodes = (nodes: TreeNode[], depth: number) => (
    <ul>
      {nodes.map((node) => {
        const isFolder = node.children !== null;
        const isOpen = expanded.has(node.path);
        const sub = isFolder ? subtreeFiles(node) : [node.path];
        const checkedCount = sub.filter((f) => checked.has(f)).length;
        const allChecked = checkedCount === sub.length && sub.length > 0;
        const someChecked = checkedCount > 0 && !allChecked;
        const downloadUrl = isFolder
          ? `/api/zip/${refPath}/${node.path.split("/").map(encodeURIComponent).join("/")}`
          : `${rawBase}/${refPath}/${node.path.split("/").map(encodeURIComponent).join("/")}?download=1`;
        return (
          <li key={(isFolder ? "d:" : "f:") + node.path}>
            <div
              draggable={!isFolder && Boolean(onInsertFile)}
              onDragStart={
                !isFolder && onInsertFile
                  ? (e) => {
                      e.dataTransfer.setData("application/x-note-path", node.path);
                      e.dataTransfer.setData("text/plain", node.path);
                      e.dataTransfer.effectAllowed = "copy";
                    }
                  : undefined
              }
              className={`group/row flex items-center gap-1.5 rounded pr-1 text-sm font-mono cursor-pointer select-none ${
                isFolder
                  ? node.path === activeFolder
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-300 hover:bg-zinc-900"
                  : node.path === activePath
                    ? "bg-sky-950 text-sky-300"
                    : "text-zinc-400 hover:bg-zinc-900"
              }`}
              style={{ paddingLeft: `${Math.min(depth, 6) * 10 + 4}px` }}
              onClick={() => {
                if (isFolder) {
                  toggleFolder(node.path);
                  onSelectFolder(node.path);
                } else onSelectFile(node.path);
              }}
              title={node.path}
            >
              {presentMode && (
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked;
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => toggleCheck(sub, e.target.checked)}
                  className="accent-sky-500 shrink-0"
                />
              )}
              <span className="w-3 shrink-0 text-zinc-600">{isFolder ? (isOpen ? "▾" : "▸") : ""}</span>
              <span className="shrink-0">{isFolder ? (isOpen ? "📂" : "📁") : fileIcon(node.name)}</span>
              <span className="truncate py-1 min-w-0 flex-1">{node.name}</span>
              {!isFolder && onInsertFile && (
                <button
                  type="button"
                  title={`插入 ${node.name} 到編輯區`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onInsertFile(node.path);
                  }}
                  className="opacity-100 md:opacity-0 md:group-hover/row:opacity-100 transition-opacity min-w-[32px] min-h-[32px] p-1.5 flex items-center justify-center shrink-0 text-zinc-400 hover:text-sky-400 rounded"
                >
                  <span className="text-base leading-none">＋</span>
                </button>
              )}
              {rawBase && refPath && (
                <a
                  href={downloadUrl}
                  download
                  title={isFolder ? `下載資料夾 ${node.name}.zip` : `下載檔案 ${node.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  className="opacity-45 hover:opacity-100 transition-opacity min-w-[32px] min-h-[32px] p-1.5 flex items-center justify-center shrink-0 text-zinc-400 hover:text-zinc-100 rounded"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
              )}
            </div>
            {isFolder && isOpen && renderNodes(node.children!, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  // 樹本體不吃 hooks 之外的東西，直接渲染
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="space-y-2">
      <div className="relative">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜尋檔名 / 路徑…"
          className="w-full rounded bg-zinc-900 border border-zinc-800 pl-2 pr-7 py-1.5 text-xs outline-none focus:border-sky-600 font-mono text-zinc-200 placeholder:text-zinc-600"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs"
            title="清除"
          >
            ✕
          </button>
        )}
      </div>

      {searchQuery.trim() ? (
        <div className="space-y-1">
          {matchingPaths.length === 0 ? (
            <p className="text-xs text-zinc-500 py-2 font-mono">無符合搜尋項</p>
          ) : (
            <>
              <ul className="space-y-0.5">
                {matchingPaths.slice(0, 50).map((p) => {
                  const isSelected = p === activePath;
                  const fileName = p.split("/").pop() || p;
                  return (
                    <li key={p}>
                      <div
                        draggable={Boolean(onInsertFile)}
                        onDragStart={
                          onInsertFile
                            ? (e) => {
                                e.dataTransfer.setData("application/x-note-path", p);
                                e.dataTransfer.setData("text/plain", p);
                                e.dataTransfer.effectAllowed = "copy";
                              }
                            : undefined
                        }
                        onClick={() => onSelectFile(p)}
                        title={p}
                        className={`group/row flex items-center gap-1.5 rounded px-2 py-1 text-xs font-mono cursor-pointer select-none truncate ${
                          isSelected ? "bg-sky-950 text-sky-300" : "text-zinc-400 hover:bg-zinc-900"
                        }`}
                      >
                        <span className="shrink-0 text-xs">{fileIcon(fileName)}</span>
                        <span className="truncate flex-1 min-w-0">{highlightMatch(p, searchQuery.trim())}</span>
                        {onInsertFile && (
                          <button
                            type="button"
                            title={`插入 ${fileName} 到編輯區`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onInsertFile(p);
                            }}
                            className="opacity-100 md:opacity-0 md:group-hover/row:opacity-100 transition-opacity min-w-[32px] min-h-[32px] p-1.5 flex items-center justify-center shrink-0 text-zinc-400 hover:text-sky-400 rounded"
                          >
                            <span className="text-base leading-none">＋</span>
                          </button>
                        )}
                        {rawBase && refPath && (
                          <a
                            href={`${rawBase}/${refPath}/${p.split("/").map(encodeURIComponent).join("/")}?download=1`}
                            download
                            title={`下載檔案 ${fileName}`}
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                            className="opacity-45 hover:opacity-100 transition-opacity min-w-[32px] min-h-[32px] p-1.5 flex items-center justify-center shrink-0 text-zinc-400 hover:text-zinc-100 rounded"
                          >
                            <svg
                              className="w-3.5 h-3.5"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {matchingPaths.length > 50 && (
                <p className="text-xs text-zinc-500 font-mono pt-1 px-1">
                  還有 {matchingPaths.length - 50} 筆…
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        renderNodes(tree, 0)
      )}
    </div>
  );
}
