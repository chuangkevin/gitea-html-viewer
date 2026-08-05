import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseRepoInput, refPathOf } from "../lib/providers";

/** ── 儲存結構 ── */
interface RepoEntry {
  provider: string;
  project: string;
  /** display label: group/repo */
  label: string;
  /** epoch ms */
  lastOpened: number;
}

const LS_RECENT = "nb:recent-repos";
const LS_PINNED = "nb:pinned-repos";
const MAX_RECENT = 8;

function loadList(key: string): RepoEntry[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]") as RepoEntry[];
  } catch {
    return [];
  }
}

function saveList(key: string, list: RepoEntry[]) {
  localStorage.setItem(key, JSON.stringify(list));
}

function repoKey(e: RepoEntry) {
  return `${e.provider}/${e.project}`;
}

/** 外部用：開啟 repo 時呼叫，更新 recent 清單 */
export function touchRecent(provider: string, project: string) {
  const label = project; // group/repo 形式
  const recent = loadList(LS_RECENT);
  const filtered = recent.filter((r) => repoKey(r) !== `${provider}/${project}`);
  filtered.unshift({ provider, project, label, lastOpened: Date.now() });
  saveList(LS_RECENT, filtered.slice(0, MAX_RECENT));
}

// ── Component ──

interface Props {
  currentProvider?: string;
  currentProject?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export default function RepoSelector({
  currentProvider,
  currentProject,
  collapsed,
  onToggleCollapse,
}: Props) {
  const navigate = useNavigate();
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<RepoEntry[]>(() => loadList(LS_RECENT));
  const [pinned, setPinned] = useState<RepoEntry[]>(() => loadList(LS_PINNED));
  const inputRef = useRef<HTMLInputElement>(null);

  // sync from localStorage when window regains focus (multi-tab)
  useEffect(() => {
    const onFocus = () => {
      setRecent(loadList(LS_RECENT));
      setPinned(loadList(LS_PINNED));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const currentKey = currentProvider && currentProject ? `${currentProvider}/${currentProject}` : null;

  const handleOpen = useCallback(() => {
    const parsed = parseRepoInput(urlInput);
    if (!parsed) {
      setError("貼上 GitHub 或 GitLab repo 網址（或 owner/repo）");
      return;
    }
    setError("");
    setUrlInput("");
    navigate(`/edit/${refPathOf(parsed.provider, parsed.projectPath)}`);
  }, [urlInput, navigate]);

  const goTo = useCallback(
    (e: RepoEntry) => {
      navigate(`/edit/${refPathOf(e.provider, e.project)}`);
    },
    [navigate]
  );

  const togglePin = useCallback((entry: RepoEntry) => {
    setPinned((prev) => {
      const key = repoKey(entry);
      const exists = prev.some((p) => repoKey(p) === key);
      const next = exists ? prev.filter((p) => repoKey(p) !== key) : [entry, ...prev];
      saveList(LS_PINNED, next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((entry: RepoEntry) => {
    setRecent((prev) => {
      const next = prev.filter((r) => repoKey(r) !== repoKey(entry));
      saveList(LS_RECENT, next);
      return next;
    });
  }, []);

  const isPinned = useCallback(
    (entry: RepoEntry) => pinned.some((p) => repoKey(p) === repoKey(entry)),
    [pinned]
  );

  // merge: pinned first, then recent (excluding already-pinned)
  const pinnedKeys = useMemo(() => new Set(pinned.map(repoKey)), [pinned]);
  const recentOnly = useMemo(() => recent.filter((r) => !pinnedKeys.has(repoKey(r))), [recent, pinnedKeys]);

  return (
    <div className="border-b border-zinc-800 pb-2 mb-2">
      <button
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 w-full text-xs uppercase tracking-wider text-zinc-500 hover:text-zinc-300 py-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 rounded"
        aria-expanded={!collapsed}
      >
        <span className="w-3 text-center">{collapsed ? "▸" : "▾"}</span>
        <span>Repo</span>
      </button>

      {!collapsed && (
        <div className="mt-1.5 space-y-2">
          {/* URL input */}
          <div className="flex gap-1">
            <input
              ref={inputRef}
              type="text"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="repo 網址 / owner/repo"
              className="flex-1 min-w-0 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs outline-none focus:border-sky-600 font-mono text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              onClick={handleOpen}
              className="rounded bg-sky-600 px-2 py-1 text-xs font-semibold hover:bg-sky-500 shrink-0"
            >
              開啟
            </button>
          </div>
          {error && <p className="text-xs text-red-400 leading-tight">{error}</p>}

          {/* Pinned */}
          {pinned.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-zinc-600 px-0.5">釘選</span>
              <ul className="mt-0.5">
                {pinned.map((entry) => (
                  <RepoItem
                    key={repoKey(entry)}
                    entry={entry}
                    active={repoKey(entry) === currentKey}
                    pinned
                    onSelect={goTo}
                    onTogglePin={togglePin}
                    onRemove={removeRecent}
                    showRemove={false}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* Recent */}
          {recentOnly.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-zinc-600 px-0.5">最近</span>
              <ul className="mt-0.5">
                {recentOnly.map((entry) => (
                  <RepoItem
                    key={repoKey(entry)}
                    entry={entry}
                    active={repoKey(entry) === currentKey}
                    pinned={false}
                    onSelect={goTo}
                    onTogglePin={togglePin}
                    onRemove={removeRecent}
                    showRemove
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Item ──

function RepoItem({
  entry,
  active,
  pinned,
  onSelect,
  onTogglePin,
  onRemove,
  showRemove,
}: {
  entry: RepoEntry;
  active: boolean;
  pinned: boolean;
  onSelect: (e: RepoEntry) => void;
  onTogglePin: (e: RepoEntry) => void;
  onRemove: (e: RepoEntry) => void;
  showRemove: boolean;
}) {
  return (
    <li
      className={`group flex items-center gap-1 rounded px-1 py-0.5 text-xs font-mono cursor-pointer select-none ${
        active ? "bg-sky-950 text-sky-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      }`}
    >
      <button
        onClick={() => onSelect(entry)}
        className="flex-1 min-w-0 truncate text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 rounded py-0.5"
        title={`${entry.provider}: ${entry.project}`}
      >
        {entry.label}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePin(entry); }}
        className={`shrink-0 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 rounded p-0.5 ${
          pinned ? "text-amber-400 hover:text-amber-300" : "text-zinc-600 hover:text-amber-400 opacity-0 group-hover:opacity-100"
        }`}
        title={pinned ? "取消釘選" : "釘選"}
        aria-label={pinned ? "取消釘選" : "釘選"}
      >
        📌
      </button>
      {showRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(entry); }}
          className="shrink-0 text-xs text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500 rounded p-0.5"
          title="從最近清單移除"
          aria-label="從最近清單移除"
        >
          ✕
        </button>
      )}
    </li>
  );
}
