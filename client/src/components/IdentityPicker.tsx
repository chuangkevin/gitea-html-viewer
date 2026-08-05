import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TeamInfo, type IdentitySuggestion } from "../lib/api";

/**
 * 團隊模式的「你是誰」帶 autocomplete 的組合輸入。
 * 輸入時 debounce 200ms 呼叫 /api/identities/suggest，
 * 下拉顯示建議；roster 來源加「成員」標記並優先排序。
 * 仍允許輸入清單中沒有的新名字（自由填寫不受限制）。
 */
export default function IdentityPicker({
  team,
  onChange,
  size = "sm",
}: {
  team: TeamInfo;
  onChange: () => void;
  size?: "sm" | "lg";
}) {
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(team.selected?.name ?? "");
  const [suggestions, setSuggestions] = useState<IdentitySuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Sync query when team selection changes externally
  useEffect(() => {
    setQuery(team.selected?.name ?? "");
  }, [team.selected?.name]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const fetchSuggestions = useCallback((q: string) => {
    api.suggestIdentities(q).then(setSuggestions).catch(() => {});
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      setActiveIdx(-1);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchSuggestions(value), 200);
      setOpen(true);
    },
    [fetchSuggestions]
  );

  async function pickByIndex(index: number) {
    setBusy(true);
    try {
      await api.selectIdentity(index);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function pickSuggestion(s: IdentitySuggestion) {
    setQuery(s.name);
    setOpen(false);
    setBusy(true);
    try {
      const idx = team.members.findIndex(
        (m) => m.name.toLowerCase() === s.name.toLowerCase()
      );
      if (idx >= 0) {
        await api.selectIdentity(idx);
      } else {
        await api.selectIdentity(null);
        await api.setGuestName(s.name);
      }
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function submitFreeText() {
    const text = query.trim();
    setOpen(false);
    setBusy(true);
    try {
      if (!text) {
        await api.selectIdentity(null);
        await api.setGuestName("");
      } else {
        const idx = team.members.findIndex(
          (m) => m.name.toLowerCase() === text.toLowerCase()
        );
        if (idx >= 0) {
          await api.selectIdentity(idx);
        } else {
          await api.selectIdentity(null);
          await api.setGuestName(text);
        }
      }
      onChange();
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setOpen(true);
        fetchSuggestions(query);
        e.preventDefault();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submitFreeText();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIdx((i) => (suggestions.length > 0 ? Math.min(i + 1, suggestions.length - 1) : -1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, -1));
        break;
      case "Enter":
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < suggestions.length) {
          void pickSuggestion(suggestions[activeIdx]);
        } else {
          void submitFreeText();
        }
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        setActiveIdx(-1);
        break;
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx >= 0 && listRef.current) {
      const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx]);

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveIdx(-1);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const base =
    size === "lg"
      ? "rounded-lg bg-zinc-900 border px-4 py-2.5 text-base w-64"
      : "rounded-lg bg-zinc-900 border px-3 py-1.5 text-sm w-48";

  return (
    <div ref={containerRef} className="relative" role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => {
          setOpen(true);
          fetchSuggestions(query);
        }}
        onBlur={() => {
          // Delay to allow click on suggestion
          setTimeout(() => {
            if (!containerRef.current?.contains(document.activeElement)) {
              setOpen(false);
              setActiveIdx(-1);
            }
          }, 150);
        }}
        onKeyDown={handleKeyDown}
        disabled={busy}
        placeholder="👤 你是誰？（選了才能編輯）"
        aria-label="選擇身分"
        aria-autocomplete="list"
        aria-controls="identity-listbox"
        className={`${base} outline-none focus:border-sky-600 focus:ring-1 focus:ring-sky-600 disabled:opacity-50 ${
          team.selected ? "border-zinc-700 text-zinc-200" : "border-sky-700 text-sky-300"
        }`}
      />
      {open && (
        <ul
          ref={listRef}
          id="identity-listbox"
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl"
        >
          {suggestions.length === 0 ? (
            <li className="px-3 py-2 text-xs text-zinc-400 italic">
              尚無可選成員，直接輸入你的名字即可
            </li>
          ) : (
            suggestions.map((s, i) => (
              <li
                key={`${s.name}-${s.source}`}
                role="option"
                aria-selected={i === activeIdx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pickSuggestion(s)}
                onMouseEnter={() => setActiveIdx(i)}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm ${
                  i === activeIdx
                    ? "bg-sky-900/60 text-white"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <span className="truncate">{s.name}</span>
                {s.email && (
                  <span className="text-xs text-zinc-500 truncate">{s.email}</span>
                )}
                {s.hasToken === false && (
                  <span className="text-xs text-zinc-500 truncate">未設定 token</span>
                )}
                {s.source === "roster" && (
                  <span className="ml-auto shrink-0 rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] text-sky-400 font-medium">
                    成員
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
