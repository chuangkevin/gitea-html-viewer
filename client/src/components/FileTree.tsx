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
  return "📄";
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
}: Props) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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
        return (
          <li key={(isFolder ? "d:" : "f:") + node.path}>
            <div
              className={`flex items-center gap-1 rounded pr-1 text-xs font-mono cursor-pointer select-none ${
                isFolder
                  ? node.path === activeFolder
                    ? "bg-zinc-800/80 text-zinc-100"
                    : "text-zinc-300 hover:bg-zinc-900"
                  : node.path === activePath
                    ? "bg-sky-950 text-sky-300"
                    : "text-zinc-400 hover:bg-zinc-900"
              }`}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
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
              <span className="truncate py-1">{node.name}</span>
            </div>
            {isFolder && isOpen && renderNodes(node.children!, depth + 1)}
          </li>
        );
      })}
    </ul>
  );

  // 樹本體不吃 hooks 之外的東西，直接渲染
  const containerRef = useRef<HTMLDivElement>(null);
  return <div ref={containerRef}>{renderNodes(tree, 0)}</div>;
}
