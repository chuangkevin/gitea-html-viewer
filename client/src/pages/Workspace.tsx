import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type AccessMode, type Me } from "../lib/api";
import { renderMarkdown, type LinkContext } from "../lib/markdown";
import { ProviderIcon, providerLabel } from "../lib/providers";
import FileTree, { buildTree, flattenFiles } from "../components/FileTree";
import IdentityPicker from "../components/IdentityPicker";
import { kindOf } from "../components/Presenter";
import { attachBridge } from "../lib/bridge";

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/**
 * 主工作區。設計原則：public repo 誰都能直接讀（不登入 = 唯讀模式），
 * 需要編輯或讀 private 時才走右上角登入。
 *
 * 團隊模式（server 有成員清單）時另有一條路：不必個人 OAuth，
 * 在 header 選「你是誰」即可用該成員的 token 讀寫，commit 記在該成員名下。
 */
export default function Workspace() {
  const { provider = "github", project = "" } = useParams();
  const navigate = useNavigate();
  const projectPath = project; // react-router 已解碼；GitLab 可含巢狀群組
  const refPath = `${provider}/${encodeURIComponent(projectPath)}`; // 路由/API 用
  const repoLeaf = projectPath.split("/").pop() || projectPath;
  const [params, setParams] = useSearchParams();
  const activePath = params.get("f") || "";

  const [me, setMe] = useState<Me | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("login");
  const [guestName, setGuestName] = useState("");
  const [needLogin, setNeedLogin] = useState(false);
  const [content, setContent] = useState("");
  const [sha, setSha] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>("clean");
  const [view, setView] = useState<"edit" | "split" | "preview">("split");
  const [error, setError] = useState("");
  const [newFile, setNewFile] = useState("");
  const [shareUrl, setShareUrl] = useState<{ url: string; slidesUrl: string } | null>(null);
  const [presentMode, setPresentMode] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [rawGrant, setRawGrant] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [activeFolder, setActiveFolder] = useState("");
  const [reloadKey, setReloadKey] = useState(0); // 換身分後強制重讀檔案樹與檔案內容
  const [dirViewMode, setDirViewMode] = useState<"continuous" | "list">("continuous");
  const [folderMdContents, setFolderMdContents] = useState<Record<string, string>>({});
  const [loadedCount, setLoadedCount] = useState(0);
  const [isFolderLoading, setIsFolderLoading] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedSite, setCopiedSite] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const dragCounter = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const loginUrl = `/api/auth/login?provider=${provider}&next=${encodeURIComponent(
    location.pathname + location.search
  )}`;

  const refreshMe = useCallback(() => api.me().then(setMe).catch(() => setMe({ login: null })), []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // 團隊模式：選了成員（或改選別人）→ 重抓身分、檔案樹與目前檔案
  const handleIdentityChange = useCallback(() => {
    void refreshMe();
    setReloadKey((k) => k + 1);
  }, [refreshMe]);

  const loadFiles = useCallback(() => {
    setNeedLogin(false);
    api
      .files(refPath)
      .then((r) => {
        setFiles(r.files.map((f) => f.path));
        setCanWrite(r.canWrite);
        setIsPrivate(r.private);
        if (r.access) setAccessMode(r.access);
        if (r.guestName !== undefined && r.guestName !== null) setGuestName(r.guestName);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [refPath, reloadKey]);

  useEffect(loadFiles, [loadFiles]);

  useEffect(() => {
    if (files !== null) {
      api.setLastRepo(provider, projectPath, activePath).catch(() => {});
    }
  }, [provider, projectPath, activePath, files]);

  const activeKind = activePath ? kindOf(activePath) : null;

  // 個人登入或團隊模式選了身分，才有資格拿 private repo 的 raw grant
  const hasIdentity = Boolean(me?.login || me?.team?.selected);

  useEffect(() => {
    if (!isPrivate || !hasIdentity || rawGrant) return;
    api.rawGrant(provider, projectPath).then((r) => setRawGrant(r.grant)).catch(() => {});
  }, [isPrivate, hasIdentity, rawGrant, provider, projectPath]);

  const rawBase = isPrivate && rawGrant ? `/rawt/${rawGrant}` : "/raw";

  useEffect(() => {
    if (!activePath) return;
    setSave("clean");
    setShareUrl(null);
    const k = kindOf(activePath);
    if (k !== "md" && k !== "text" && k !== "html") return;
    api
      .readFile(refPath, activePath)
      .then((f) => {
        setContent(f.content);
        setSha(f.sha);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [refPath, activePath, reloadKey]);

  useEffect(() => {
    if (activeKind !== "html" || !iframeRef.current) return;
    const iframe = iframeRef.current;
    const cleanup = attachBridge({
      iframe,
      readFile: async (path: string) => {
        const file = await api.readFile(refPath, path);
        return file.content;
      },
      saveFile: async (path: string, contentStr: string) => {
        const msg = `更新 ${path}（via 互動頁）`;
        const targetSha = path === activePath ? sha : undefined;
        const res = await api.saveFile(refPath, path, contentStr, targetSha, msg);
        if (path === activePath) {
          setSha(res.sha);
          setContent(contentStr);
          setSave("saved");
          setTimeout(() => setSave((s) => (s === "saved" ? "clean" : s)), 2000);
        }
      },
      openPath: (path: string) => {
        setActiveFolder("");
        setParams({ f: path });
      },
    });
    return cleanup;
  }, [activeKind, activePath, refPath, sha, setParams]);

  async function handleSave() {
    if (!activePath || !canWrite) return;
    setSave("saving");
    try {
      const r = await api.saveFile(refPath, activePath, content, sha);
      setSha(r.sha);
      setSave("saved");
      setTimeout(() => setSave((s) => (s === "saved" ? "clean" : s)), 2000);
    } catch (e) {
      setSave("error");
      setError(String((e as Error).message || e));
    }
  }

  async function handleCreate() {
    let p = newFile.trim();
    if (!p) return;
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    setNewFile("");
    setFiles((f) => (f ? [...f, p] : [p]));
    setParams({ f: p });
    setContent(`# ${p.replace(/\.md$/i, "").split("/").pop()}\n\n`);
    setSha(undefined);
    setSave("dirty");
  }

  async function handleShare() {
    if (!activePath) return;
    const title = content.match(/^#\s+(.+)$/m)?.[1];
    const r = await api.share(projectPath, activePath, title);
    setShareUrl({ url: r.url, slidesUrl: r.slidesUrl });
  }

  // 展示順序一律取檔案樹的資料夾排序
  const sortedFiles = useMemo(() => (files ? flattenFiles(buildTree(files)) : []), [files]);
  const checkedInOrder = useMemo(() => sortedFiles.filter((f) => checked.has(f)), [sortedFiles, checked]);
  const folderFiles = useMemo(
    () => (activeFolder ? sortedFiles.filter((f) => f.startsWith(activeFolder + "/")) : []),
    [sortedFiles, activeFolder]
  );

  function startPresent(items: string[], title: string) {
    if (items.length === 0) return;
    const g = isPrivate && rawGrant ? `&grant=${rawGrant}` : "";
    navigate(
      `/present/${refPath}?list=${encodeURIComponent(JSON.stringify(items))}&title=${encodeURIComponent(title)}${g}`
    );
  }

  async function handleShareSet() {
    if (checkedInOrder.length === 0) return;
    try {
      const r = await api.shareSet(projectPath, checkedInOrder, `${repoLeaf} 展示`);
      setShareUrl({ url: r.url, slidesUrl: r.url });
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  // Cmd/Ctrl+S 存檔
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const readOnly = !canWrite;
  const effectiveView = readOnly ? "preview" : view;

  const linkContext = useMemo<LinkContext>(
    () => ({
      provider,
      project: projectPath,
      currentPath: activePath,
      files: files || [],
    }),
    [provider, projectPath, activePath, files]
  );
  const html = useMemo(() => renderMarkdown(content, linkContext), [content, linkContext]);

  const handlePreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      if (anchor.target === "_blank" || anchor.getAttribute("target") === "_blank") return;
      if (href.startsWith("/edit/")) {
        e.preventDefault();
        navigate(href);
      }
    },
    [navigate]
  );

  const dirParam = params.get("dir");
  const cleanDir = useMemo(() => (dirParam || "").replace(/^\/+|\/+$/g, ""), [dirParam]);

  const targetUploadDir = useMemo(() => {
    if (params.has("dir")) return cleanDir;
    if (activePath && activePath.includes("/")) {
      return activePath.split("/").slice(0, -1).join("/");
    }
    return "";
  }, [params, cleanDir, activePath]);

  const targetDirLabel = targetUploadDir ? targetUploadDir : "根目錄";

  const getCurrentDirContext = useCallback(() => {
    if (params.has("dir")) return cleanDir;
    if (activeFolder) return activeFolder;
    if (activePath && activePath.includes("/")) {
      return activePath.split("/").slice(0, -1).join("/");
    }
    return "";
  }, [params, cleanDir, activeFolder, activePath]);

  async function handleCreateFolder() {
    if (!canWrite) return;
    const input = window.prompt("請輸入資料夾名稱／路徑（例如 docs/2026/q3）：");
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed) {
      setError("資料夾名稱不可為空");
      return;
    }
    if (trimmed.includes("..")) {
      setError("資料夾路徑不可包含 ..");
      return;
    }
    if (trimmed.startsWith("/")) {
      setError("資料夾路徑不可以 / 開頭");
      return;
    }
    if (trimmed.replace(/\//g, "").trim() === "") {
      setError("資料夾名稱不可只有斜線");
      return;
    }

    const baseDir = getCurrentDirContext();
    let folderPath = trimmed.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    if (baseDir && !folderPath.startsWith(baseDir + "/") && folderPath !== baseDir) {
      folderPath = `${baseDir}/${folderPath}`;
    }

    const folderLeaf = folderPath.split("/").pop() || folderPath;
    const newFilePath = `${folderPath}/README.md`;
    const contentStr = `# ${folderLeaf}\n`;
    const commitMsg = `docs: 新增資料夾 ${folderPath}`;

    try {
      await api.saveFile(refPath, newFilePath, contentStr, undefined, commitMsg);
      await loadFiles();
      setParams({ f: newFilePath });
    } catch (err: any) {
      setError(String(err.message || err));
    }
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (!canWrite) {
      setError("唯讀，無法上傳");
      return;
    }

    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (droppedFiles.length === 0) return;

    const failures: string[] = [];
    let lastUploadedPath = "";

    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i];
      const cleanFileName = file.name.replace(/\\/g, "-");
      const filePath = targetUploadDir ? `${targetUploadDir}/${cleanFileName}` : cleanFileName;

      setUploadProgress(`上傳中 ${i + 1} / ${droppedFiles.length}：${cleanFileName}`);

      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result as string;
            const b64 = res.includes(",") ? res.split(",")[1] : res;
            resolve(b64);
          };
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(file);
        });

        const message = `docs: 上傳 ${cleanFileName}`;
        await api.uploadFile(refPath, filePath, base64, message);
        lastUploadedPath = filePath;
      } catch (err: any) {
        let msg = err.message || "上傳失敗";
        if (err.status === 413 || err.code === "file_too_large" || err.message === "file_too_large") {
          msg = "檔案超過 20MB 上限";
        } else if (err.status === 401 || err.status === 403) {
          msg = "沒有寫入權限，請先登入或選身分";
        }
        failures.push(`${cleanFileName}: ${msg}`);
      }
    }

    setUploadProgress(null);
    await loadFiles();

    if (droppedFiles.length === 1 && failures.length === 0 && lastUploadedPath) {
      setParams({ f: lastUploadedPath });
    }

    if (failures.length > 0) {
      setError(`以下檔案上傳失敗：\n${failures.join("\n")}`);
    }
  };

  const dirViewItems = useMemo(() => {
    if (!params.has("dir") || !files) return { subfolders: [], directFiles: [] };
    const prefix = cleanDir ? cleanDir + "/" : "";
    const subfoldersSet = new Set<string>();
    const directFiles: string[] = [];

    for (const f of files) {
      if (prefix === "" || f.startsWith(prefix)) {
        const rel = prefix ? f.slice(prefix.length) : f;
        if (!rel) continue;
        const parts = rel.split("/");
        if (parts.length === 1) {
          directFiles.push(f);
        } else {
          const subName = parts[0];
          const subPath = cleanDir ? `${cleanDir}/${subName}` : subName;
          subfoldersSet.add(subPath);
        }
      }
    }
    return {
      subfolders: Array.from(subfoldersSet).sort(),
      directFiles: directFiles.sort(),
    };
  }, [params, cleanDir, files]);

  const targetPrefix = cleanDir ? cleanDir + "/" : "";
  const matchingMdFiles = useMemo(() => {
    if (!files || !params.has("dir")) return [];
    return files
      .filter((f) => {
        if (!f.toLowerCase().endsWith(".md")) return false;
        if (!cleanDir) return true;
        return f.startsWith(targetPrefix);
      })
      .sort((a, b) => a.localeCompare(b));
  }, [files, params, cleanDir, targetPrefix]);

  const maxFiles = 50;
  const cappedMdFiles = useMemo(() => matchingMdFiles.slice(0, maxFiles), [matchingMdFiles]);
  const isCapped = matchingMdFiles.length > maxFiles;

  useEffect(() => {
    if (!params.has("dir") || cappedMdFiles.length === 0) {
      setFolderMdContents({});
      setLoadedCount(0);
      setIsFolderLoading(false);
      return;
    }

    let cancelled = false;
    setIsFolderLoading(true);
    setFolderMdContents({});
    setLoadedCount(0);

    async function loadAll() {
      const total = cappedMdFiles.length;
      const contentsMap: Record<string, string> = {};

      const initialBatchSize = Math.min(5, total);
      const initialFiles = cappedMdFiles.slice(0, initialBatchSize);

      await Promise.all(
        initialFiles.map(async (filePath) => {
          try {
            const res = await api.readFile(refPath, filePath);
            if (!cancelled) {
              contentsMap[filePath] = res.content;
            }
          } catch {
            if (!cancelled) {
              contentsMap[filePath] = `*無法載入檔案: ${filePath}*`;
            }
          }
        })
      );

      if (cancelled) return;
      setFolderMdContents({ ...contentsMap });
      setLoadedCount(initialBatchSize);

      for (let i = initialBatchSize; i < total; i++) {
        if (cancelled) return;
        const filePath = cappedMdFiles[i];
        try {
          const res = await api.readFile(refPath, filePath);
          if (!cancelled) {
            contentsMap[filePath] = res.content;
            setFolderMdContents({ ...contentsMap });
            setLoadedCount(i + 1);
          }
        } catch {
          if (!cancelled) {
            contentsMap[filePath] = `*無法載入檔案: ${filePath}*`;
            setFolderMdContents({ ...contentsMap });
            setLoadedCount(i + 1);
          }
        }
      }

      if (!cancelled) {
        setIsFolderLoading(false);
      }
    }

    void loadAll();

    return () => {
      cancelled = true;
    };
  }, [params, cleanDir, cappedMdFiles, refPath, reloadKey]);

  async function copyTextToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fallback to prompt
      }
    }
    prompt("請複製以下連結：", text);
    return true;
  }

  function handleCopyShare() {
    const paramStr = params.has("dir")
      ? `?dir=${encodeURIComponent(cleanDir)}`
      : `?f=${encodeURIComponent(activePath)}`;
    const url = `${window.location.origin}/edit/${provider}/${encodeURIComponent(projectPath)}${paramStr}`;
    void copyTextToClipboard(url).then(() => {
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2000);
    });
  }

  function handleCopySite() {
    const paramStr = params.has("dir")
      ? `?dir=${encodeURIComponent(cleanDir)}`
      : `?f=${encodeURIComponent(activePath)}`;
    const url = `${window.location.origin}/site/${provider}/${encodeURIComponent(projectPath)}${paramStr}`;
    void copyTextToClipboard(url).then(() => {
      setCopiedSite(true);
      setTimeout(() => setCopiedSite(false), 2000);
    });
  }

  type MentionItem = {
    type: "file" | "dir";
    path: string;
    label: string;
  };

  const mentionCandidates = useMemo(() => {
    if (!files) return [];
    const dirs = new Set<string>();
    const list: MentionItem[] = [];

    for (const f of files) {
      const parts = f.split("/");
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        dirs.add(acc);
      }
    }

    for (const d of Array.from(dirs).sort()) {
      list.push({ type: "dir", path: d, label: `${d}/` });
    }
    for (const f of [...files].sort()) {
      list.push({ type: "file", path: f, label: f });
    }

    return list;
  }, [files]);

  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const filteredMentions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return mentionCandidates.filter((item) => item.path.toLowerCase().includes(q)).slice(0, 12);
  }, [mentionCandidates, mentionQuery]);

  useEffect(() => {
    if (mentionIndex >= filteredMentions.length && filteredMentions.length > 0) {
      setMentionIndex(filteredMentions.length - 1);
    }
  }, [filteredMentions.length, mentionIndex]);

  const updateMentionTrigger = useCallback((val: string, cursorPos: number) => {
    const textBefore = val.slice(0, cursorPos);
    const match = textBefore.match(/(?:^|\s)@([^\s]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const selectMention = useCallback(
    (item: MentionItem) => {
      const editor = editorRef.current;
      if (!editor) return;

      const val = editor.value;
      const cursorPos = editor.selectionStart;
      const textBefore = val.slice(0, cursorPos);
      const match = textBefore.match(/(?:^|\s)@([^\s]*)$/);
      if (!match) return;

      const atPos = match.index! + match[0].indexOf("@");

      let replacement = "";
      if (item.type === "dir") {
        const folderName = item.path.split("/").pop() || item.path;
        replacement = `[${folderName}/](/${item.path}/)`;
      } else {
        const fileName = item.path.split("/").pop() || item.path;
        const nameNoExt = fileName.replace(/\.[^/.]+$/, "");
        replacement = `[${nameNoExt}](/${item.path})`;
      }

      const newContent = val.slice(0, atPos) + replacement + val.slice(cursorPos);
      const newCursorPos = atPos + replacement.length;

      setContent(newContent);
      setSave("dirty");
      setMentionQuery(null);

      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          editorRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    },
    []
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionQuery !== null && filteredMentions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % filteredMentions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const safeIndex = Math.max(0, Math.min(mentionIndex, filteredMentions.length - 1));
          const item = filteredMentions[safeIndex];
          if (item) {
            selectMention(item);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }
    },
    [mentionQuery, filteredMentions, mentionIndex, selectMention]
  );

  // ── 分割檢視：編輯區與預覽區依捲動比例雙向同步 ──
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // 同步旗標：記住「現在是哪一邊在帶動」加一段冷卻時間。被帶動的那一邊會因為
  // scrollTop 被改而回彈一個 scroll 事件，冷卻期內直接忽略，避免兩邊互相觸發。
  // 用時間戳而非 callback 清旗標——不依賴 rAF/timer，卡不住。
  const syncSource = useRef<HTMLElement | null>(null);
  const syncUntil = useRef(0);

  const syncScroll = useCallback(
    (from: HTMLElement | null, to: HTMLElement | null) => {
      if (effectiveView !== "split" || !from || !to) return;
      const now = performance.now();
      if (syncSource.current !== from && now < syncUntil.current) return; // 回彈事件
      const fromMax = from.scrollHeight - from.clientHeight;
      const toMax = to.scrollHeight - to.clientHeight;
      if (fromMax <= 0 || toMax <= 0) return;
      syncSource.current = from;
      syncUntil.current = now + 120;
      to.scrollTop = (from.scrollTop / fromMax) * toMax;
    },
    [effectiveView]
  );

  // private repo 且未登入：整頁登入提示
  if (needLogin) {
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div className="space-y-4">
          <p className="text-3xl">🔒</p>
          <p className="text-zinc-300">
            <span className="font-mono">{projectPath}</span> 不存在，或是私有 repo。
          </p>
          <p className="text-base text-zinc-500">若你有這個 repo 的權限，登入後即可存取。</p>
          {me?.team?.enabled && !me.login && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-400">或者，選一下你是誰（團隊模式）：</p>
              <IdentityPicker team={me.team} onChange={handleIdentityChange} size="lg" />
            </div>
          )}
          {me?.providers?.[provider as "github" | "gitlab"] ? (
            <a
              href={loginUrl}
              className="inline-flex items-center gap-2 rounded-lg bg-white text-zinc-900 font-semibold px-5 py-2.5 hover:bg-zinc-200"
            >
              <ProviderIcon provider={provider} className="h-5 w-5" />
              使用 {providerLabel(provider)} 登入
            </a>
          ) : (
            <p className="text-sm text-zinc-600">此站尚未設定 {providerLabel(provider)} OAuth，暫時無法登入。</p>
          )}
          <div>
            <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
              ← 回首頁
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b border-zinc-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <Link to="/" className="font-mono font-bold">
          note<span className="text-sky-400">-bridge</span>
        </Link>
        <span className="font-mono text-xs text-zinc-500">
          {__APP_VERSION__}-{__BUILD_SHA__}
        </span>
        <span className="font-mono text-base text-zinc-500 truncate">{projectPath}</span>
        {readOnly && (
          <span
            className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
            title={
              me?.team?.enabled && !me.team.selected
                ? "先在右上角選「你是誰」才能編輯"
                : "沒有這個 repo 的寫入權限"
            }
          >
            {me?.team?.enabled && !me.team.selected && !me.login ? "唯讀 · 先選身分" : "唯讀"}
          </span>
        )}
        <div className="flex-1" />
        {activePath && (activeKind === "md" || activeKind === "html") && !readOnly && (
          <div className="hidden md:flex rounded-lg border border-zinc-800 overflow-hidden text-sm">
            {(["edit", "split", "preview"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 ${view === v ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
              >
                {v === "edit" ? "編輯" : v === "split" ? "分割" : "預覽"}
              </button>
            ))}
          </div>
        )}
        {activePath && activeKind === "md" && (
          <button
            onClick={() => navigate(`/p/${refPath}/${activePath}`)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400"
          >
            🎞️ 簡報
          </button>
        )}
        {(activePath || params.has("dir")) && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleCopyShare}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors"
              title="分享＝在 note 裡開啟"
            >
              {copiedShare ? "已複製 ✓" : "🔗 分享"}
            </button>
            <button
              onClick={handleCopySite}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors"
              title="獨立網站＝乾淨的網頁、沒有 note 介面"
            >
              {copiedSite ? "已複製 ✓" : "🌐 分享為獨立網站"}
            </button>
          </div>
        )}
        {activePath && (activeKind === "md" || activeKind === "html") && canWrite && (
          <>
            {/* 分享連結的內容是用「分享者的 session」持續拉取，團隊身分沒有 session，
                所以分享功能仍只開給個人 OAuth 登入者 */}
            {me?.login && (
              <button
                onClick={handleShare}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400"
              >
                分享 Token
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={save === "saving"}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"
            >
              {save === "saving" ? "commit 中…" : save === "saved" ? "已 commit ✓" : "存檔（commit）"}
            </button>
          </>
        )}
        {/* 免登入 open 模式：顯示署名輸入框（訪客 commit author 名字） */}
        {accessMode === "open" && me && !me.login && !me.team?.selected && (
          <input
            type="text"
            defaultValue={guestName}
            placeholder="你是誰？（選填，會寫進 commit）"
            onBlur={(e) => void api.setGuestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-500 max-w-[200px]"
          />
        )}
        {/* 團隊模式：不必個人 OAuth，選「你是誰」就用該成員的 token 讀寫 */}
        {me && !me.login && me.team?.enabled && (
          <IdentityPicker team={me.team} onChange={handleIdentityChange} />
        )}
        {/* 右上角：未登入顯示登入鈕（依目前 repo 來源） */}
        {me && !me.login && me.providers?.[provider as "github" | "gitlab"] && (
          <a
            href={loginUrl}
            className={
              me.team?.enabled
                ? "inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
                : "inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400"
            }
          >
            <ProviderIcon provider={provider} className="h-4 w-4" />
            登入
          </a>
        )}
        {me?.login && (
          <span className="flex items-center gap-1.5 text-sm text-zinc-500">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
            {me.login}
          </span>
        )}
        {/* Admin 連結 */}
        {me?.admin?.enabled && (
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400"
            title="管理控制台"
          >
            ⚙️ 管理
          </Link>
        )}
      </header>

      {shareUrl && (
        <div className="border-b border-sky-900/50 bg-sky-950/40 px-4 py-2 text-sm flex flex-wrap items-center gap-x-6 gap-y-1">
          <span className="text-sky-300">已建立公開分享：</span>
          <a href={shareUrl.url} target="_blank" rel="noreferrer" className="text-sky-400 underline">
            📄 文件頁 {shareUrl.url}
          </a>
          <a href={shareUrl.slidesUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline">
            🎞️ 簡報模式 {shareUrl.slidesUrl}
          </a>
          <button className="ml-auto text-zinc-500 hover:text-zinc-300" onClick={() => setShareUrl(null)}>
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300 flex">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setError("")}>✕</button>
        </div>
      )}
      {uploadProgress && (
        <div className="border-b border-sky-900/50 bg-sky-950/60 px-4 py-2 text-sm text-sky-200 flex items-center gap-2 font-mono">
          <span className="animate-pulse">⏳</span>
          <span>{uploadProgress}</span>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* 檔案樹 */}
        <aside
          className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 hidden sm:block relative"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div
              className={`absolute inset-0 z-50 flex flex-col items-center justify-center border-2 border-dashed p-4 text-center backdrop-blur-sm pointer-events-none ${
                canWrite
                  ? "border-sky-500 bg-sky-950/80 text-sky-200"
                  : "border-red-500 bg-red-950/80 text-red-200"
              }`}
            >
              <div className="text-3xl mb-1">{canWrite ? "📥" : "🔒"}</div>
              <div className="font-mono text-xs font-semibold">
                {canWrite ? `放開以上傳到 ${targetDirLabel}` : "唯讀，無法上傳"}
              </div>
            </div>
          )}
          {canWrite && (
            <div className="flex gap-1.5 mb-3">
              <input
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="新檔名…"
                className="flex-1 min-w-0 rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-sky-600"
              />
              <button
                onClick={handleCreate}
                className="rounded bg-zinc-800 px-2 text-sm text-zinc-300 hover:bg-zinc-700"
                title="新增檔案"
              >
                ＋
              </button>
              <button
                onClick={handleCreateFolder}
                className="rounded bg-zinc-800 px-2 text-sm text-zinc-300 hover:bg-zinc-700 font-mono text-xs flex items-center justify-center whitespace-nowrap"
                title="新增資料夾"
              >
                📁+
              </button>
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-zinc-600">檔案</span>
            <button
              onClick={() => {
                setPresentMode((v) => !v);
                if (presentMode) setChecked(new Set());
              }}
              className={`rounded px-2 py-0.5 text-xs border ${
                presentMode
                  ? "border-sky-600 bg-sky-950 text-sky-300"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
              }`}
              title="勾選檔案組成展示清單"
            >
              🎬 展示模式
            </button>
          </div>
          {!files ? (
            <p className="text-sm text-zinc-600">載入中…</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-zinc-600">
              {canWrite ? "repo 是空的，建立第一份 .md 吧" : "這個 repo 是空的"}
            </p>
          ) : (
            <FileTree
              paths={files}
              activePath={activePath}
              activeFolder={params.has("dir") ? cleanDir : activeFolder}
              onSelectFile={(f) => {
                setActiveFolder("");
                setParams({ f });
              }}
              onSelectFolder={(dir) => {
                setActiveFolder(dir);
                setParams({ dir });
              }}
              presentMode={presentMode}
              checked={checked}
              onCheckedChange={setChecked}
            />
          )}
          {presentMode && (
            <div className="sticky bottom-0 mt-3 -mx-3 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 space-y-1.5">
              <p className="text-xs text-zinc-500">已勾選 {checkedInOrder.length} 個檔案（依資料夾排序播放）</p>
              <button
                onClick={() => startPresent(checkedInOrder, `${repoLeaf} 展示`)}
                disabled={checkedInOrder.length === 0}
                className="w-full rounded bg-sky-600 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                ▶ 開始展示
              </button>
              {canWrite && me?.login && (
                <button
                  onClick={handleShareSet}
                  disabled={checkedInOrder.length === 0}
                  className="w-full rounded border border-zinc-700 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 disabled:opacity-40"
                >
                  🔗 分享展示集
                </button>
              )}
            </div>
          )}
        </aside>

        {/* 編輯／預覽 */}
        <main
          className="flex-1 flex flex-col min-w-0 min-h-0 relative overflow-hidden"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div
              className={`absolute inset-0 z-50 flex flex-col items-center justify-center border-2 border-dashed p-6 text-center backdrop-blur-sm pointer-events-none ${
                canWrite
                  ? "border-sky-500 bg-sky-950/80 text-sky-200"
                  : "border-red-500 bg-red-950/80 text-red-200"
              }`}
            >
              <div className="text-5xl mb-3">{canWrite ? "📥" : "🔒"}</div>
              <div className="font-mono text-base font-semibold">
                {canWrite ? `放開以上傳到 ${targetDirLabel}` : "唯讀，無法上傳"}
              </div>
            </div>
          )}
          {params.has("dir") ? (
          <div className="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold font-mono text-zinc-100 flex items-center gap-2">
                  📁 {cleanDir || "根目錄"}
                </h2>
                {matchingMdFiles.length > 0 && dirViewMode === "continuous" && (
                  isFolderLoading ? (
                    <span className="text-xs text-amber-400 bg-amber-950/60 border border-amber-800/60 px-2 py-0.5 rounded font-mono">
                      載入中 …（已載入 {loadedCount} / {cappedMdFiles.length} 份）
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded font-mono">
                      已載入 {loadedCount} / {cappedMdFiles.length} 份
                    </span>
                  )
                )}
              </div>
              <div className="flex items-center gap-2">
                {cleanDir && (
                  <button
                    onClick={() => {
                      const parentDir = cleanDir.split("/").slice(0, -1).join("/");
                      setParams({ dir: parentDir });
                    }}
                    className="text-sm border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white px-3 py-1.5 rounded flex items-center gap-1"
                  >
                    ⬆️ 上一層
                  </button>
                )}
                {matchingMdFiles.length > 0 && (
                  <button
                    onClick={() => setDirViewMode((m) => (m === "continuous" ? "list" : "continuous"))}
                    className="text-sm border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white px-3 py-1.5 rounded flex items-center gap-1"
                  >
                    {dirViewMode === "continuous" ? "📋 切換為清單" : "📖 切換為連續閱讀"}
                  </button>
                )}
              </div>
            </div>

            {matchingMdFiles.length === 0 ? (
              <div>
                <div className="p-4 mb-4 rounded bg-amber-950/40 border border-amber-800/50 text-amber-300 text-sm">
                  這個資料夾沒有可閱讀的 .md
                </div>
                <div className="divide-y divide-zinc-900 border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
                  {dirViewItems.subfolders.map((sf) => {
                    const folderName = sf.split("/").pop() || sf;
                    return (
                      <button
                        key={sf}
                        onClick={() => setParams({ dir: sf })}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-900 text-left transition-colors font-mono text-sm text-sky-400"
                      >
                        <span>📁</span>
                        <span className="font-semibold">{folderName}/</span>
                      </button>
                    );
                  })}
                  {dirViewItems.directFiles.map((df) => {
                    const fileName = df.split("/").pop() || df;
                    return (
                      <button
                        key={df}
                        onClick={() => setParams({ f: df })}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-900 text-left transition-colors font-mono text-sm text-zinc-200"
                      >
                        <span>📄</span>
                        <span>{fileName}</span>
                      </button>
                    );
                  })}
                  {dirViewItems.subfolders.length === 0 && dirViewItems.directFiles.length === 0 && (
                    <div className="p-6 text-center text-zinc-500 text-sm">此資料夾是空的</div>
                  )}
                </div>
              </div>
            ) : dirViewMode === "list" ? (
              <div className="divide-y divide-zinc-900 border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
                {dirViewItems.subfolders.map((sf) => {
                  const folderName = sf.split("/").pop() || sf;
                  return (
                    <button
                      key={sf}
                      onClick={() => setParams({ dir: sf })}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-900 text-left transition-colors font-mono text-sm text-sky-400"
                    >
                      <span>📁</span>
                      <span className="font-semibold">{folderName}/</span>
                    </button>
                  );
                })}
                {dirViewItems.directFiles.map((df) => {
                  const fileName = df.split("/").pop() || df;
                  return (
                    <button
                      key={df}
                      onClick={() => setParams({ f: df })}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-900 text-left transition-colors font-mono text-sm text-zinc-200"
                    >
                      <span>📄</span>
                      <span>{fileName}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-8">
                {cappedMdFiles.map((p, idx) => {
                  const rawMd = folderMdContents[p];
                  if (rawMd === undefined) {
                    return (
                      <div key={p} className="p-4 border border-zinc-800/60 rounded bg-zinc-950/40 text-xs text-zinc-500 font-mono">
                        📄 {p} (載入中…)
                      </div>
                    );
                  }
                  const itemLinkCtx: LinkContext = {
                    provider,
                    project: projectPath,
                    currentPath: p,
                    files: files || [],
                  };
                  const itemHtml = renderMarkdown(rawMd, itemLinkCtx);
                  return (
                    <div key={p} className="mb-8">
                      {idx > 0 && <hr className="my-8 border-zinc-800" />}
                      <div className="flex items-center gap-2 border-b border-zinc-800 pb-2 mb-4">
                        <span className="text-zinc-500 text-sm font-mono">📄</span>
                        <button
                          onClick={() => setParams({ f: p })}
                          className="text-base font-semibold font-mono text-sky-400 hover:underline hover:text-sky-300 text-left"
                          title="點擊切換至單檔閱讀"
                        >
                          {p}
                        </button>
                      </div>
                      <article
                        className="doc max-w-none"
                        onClick={handlePreviewClick}
                        dangerouslySetInnerHTML={{ __html: itemHtml }}
                      />
                    </div>
                  );
                })}
                {isCapped && (
                  <div className="mt-8 p-4 text-center border-t border-zinc-800 text-xs text-zinc-500 font-mono">
                    （已達 50 份檔案上限，其餘檔案未載入）
                  </div>
                )}
              </div>
            )}
          </div>
        ) : activeFolder ? (
          <div className="flex-1 grid place-items-center text-center px-6">
            <div className="space-y-3">
              <p className="text-3xl">📂</p>
              <p className="font-mono text-base text-zinc-300">{activeFolder}/</p>
              <p className="text-sm text-zinc-500">{folderFiles.length} 個檔案</p>
              <button
                onClick={() => startPresent(folderFiles, activeFolder)}
                disabled={folderFiles.length === 0}
                className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                ▶ 連續模式展示（依資料夾排序）
              </button>
            </div>
          </div>
        ) : !activePath ? (
          <div className="flex-1 grid place-items-center text-zinc-600 text-base">
            從左側選擇檔案{canWrite ? "，或建立新檔" : ""}
          </div>
        ) : activeKind === "pdf" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="border-b border-zinc-800 px-4 py-2 flex items-center justify-between bg-zinc-950/50 shrink-0">
              <span className="font-mono text-sm text-zinc-300 truncate">📕 {activePath}</span>
              <a
                href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}?download=1`}
                download
                className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 font-semibold flex items-center gap-1 shrink-0"
              >
                ⬇️ 下載
              </a>
            </div>
            <iframe
              src={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}#view=FitH`}
              className="w-full flex-1 border-0 bg-white"
              title={activePath}
            />
          </div>
        ) : activeKind === "image" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="border-b border-zinc-800 px-4 py-2 flex items-center justify-between bg-zinc-950/50 shrink-0">
              <span className="font-mono text-sm text-zinc-300 truncate">🖼️ {activePath}</span>
              <a
                href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}?download=1`}
                download
                className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 font-semibold flex items-center gap-1 shrink-0"
              >
                ⬇️ 下載
              </a>
            </div>
            <div className="flex-1 grid place-items-center p-6 overflow-auto bg-zinc-950/30">
              <img
                src={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}`}
                alt={activePath}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          </div>
        ) : activeKind === "other" ? (
          <div className="flex-1 grid place-items-center p-6">
            <div className="border border-zinc-800 bg-zinc-950 p-8 rounded-xl max-w-md w-full text-center space-y-4 shadow-xl">
              <div className="text-5xl">📦</div>
              <div className="font-mono font-semibold text-lg text-zinc-100 truncate" title={activePath}>
                {activePath.split("/").pop()}
              </div>
              <div className="font-mono text-xs text-zinc-500 truncate">{activePath}</div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
                <a
                  href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}?download=1`}
                  download
                  className="w-full sm:w-auto rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold text-white hover:bg-sky-500 flex items-center justify-center gap-1.5"
                >
                  ⬇️ 下載
                </a>
                <a
                  href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full sm:w-auto rounded-lg border border-zinc-700 px-5 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white flex items-center justify-center gap-1.5"
                >
                  在新分頁開啟 ↗
                </a>
              </div>
            </div>
          </div>
        ) : activeKind === "text" ? (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="border-b border-zinc-800 px-4 py-2 flex items-center justify-between bg-zinc-950/50 shrink-0">
              <span className="font-mono text-sm text-zinc-300 truncate">📄 {activePath}</span>
              <a
                href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}?download=1`}
                download
                className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 font-semibold flex items-center gap-1 shrink-0"
              >
                ⬇️ 下載
              </a>
            </div>
            <pre className="flex-1 overflow-auto p-6 text-sm font-mono text-zinc-300 whitespace-pre-wrap">
              {content}
            </pre>
          </div>
        ) : (
          <div className="flex-1 flex min-w-0 relative">
            {effectiveView !== "preview" && (
              <textarea
                ref={editorRef}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setSave("dirty");
                  updateMentionTrigger(e.target.value, e.target.selectionStart);
                }}
                onSelect={(e) => {
                  updateMentionTrigger(e.currentTarget.value, e.currentTarget.selectionStart);
                }}
                onKeyUp={(e) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                    updateMentionTrigger(e.currentTarget.value, e.currentTarget.selectionStart);
                  }
                }}
                onKeyDown={handleTextareaKeyDown}
                onScroll={() => syncScroll(editorRef.current, previewRef.current)}
                spellCheck={false}
                className={`${effectiveView === "split" ? "w-1/2" : "w-full"} resize-none bg-zinc-950 p-5 font-mono text-base leading-7 outline-none border-r border-zinc-900`}
              />
            )}
            {mentionQuery !== null && filteredMentions.length > 0 && (
              <div className="absolute left-6 top-14 z-50 w-80 max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
                <div className="px-3 py-1.5 text-xs text-zinc-400 border-b border-zinc-800 font-mono flex justify-between">
                  <span>@ 自動完成 ({filteredMentions.length})</span>
                  <span>↑↓ 移動 · Enter/Tab 選取</span>
                </div>
                {filteredMentions.map((item, idx) => (
                  <button
                    key={`${item.type}:${item.path}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectMention(item);
                    }}
                    onMouseEnter={() => setMentionIndex(idx)}
                    className={`w-full text-left px-3 py-2 text-sm font-mono flex items-center gap-2 transition-colors ${
                      idx === mentionIndex ? "bg-sky-900/60 text-white" : "text-zinc-300 hover:bg-zinc-800"
                    }`}
                  >
                    <span className="text-base">{item.type === "dir" ? "📁" : "📄"}</span>
                    <span className="truncate flex-1">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            {effectiveView !== "edit" && (
              <div className={`${effectiveView === "split" ? "w-1/2" : "w-full"} flex flex-col min-h-0 overflow-hidden`}>
                {activeKind === "html" ? (
                  <div className="flex-1 flex flex-col min-h-0">
                    <div className="border-b border-zinc-800 px-4 py-2 flex items-center justify-between bg-zinc-950/50 shrink-0">
                      <span className="font-mono text-sm text-zinc-300 truncate">🌐 {activePath}</span>
                      <div className="flex items-center gap-2">
                        <a
                          href={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}?download=1`}
                          download
                          className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 font-semibold flex items-center gap-1 shrink-0"
                        >
                          ⬇️ 下載
                        </a>
                        <a
                          href={`/site/${provider}/${encodeURIComponent(projectPath)}?f=${encodeURIComponent(activePath)}${isPrivate && rawGrant ? `&grant=${rawGrant}` : ""}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 font-semibold flex items-center gap-1 shrink-0"
                        >
                          在新分頁開啟獨立網站 ↗
                        </a>
                      </div>
                    </div>
                    <iframe
                      ref={iframeRef}
                      key={activePath}
                      src={`/site/${provider}/${encodeURIComponent(projectPath)}?f=${encodeURIComponent(activePath)}${isPrivate && rawGrant ? `&grant=${rawGrant}` : ""}`}
                      /* ⚠️ 刻意不給 allow-same-origin：iframe 會是 opaque origin，能跑 JS 但碰不到 note 主站的 cookie / DOM */
                      sandbox="allow-scripts allow-popups allow-forms allow-modals"
                      className="w-full flex-1 border-0 bg-white"
                      title={activePath}
                    />
                  </div>
                ) : (
                  <div
                    ref={previewRef}
                    onScroll={() => syncScroll(previewRef.current, editorRef.current)}
                    onClick={handlePreviewClick}
                    className={`flex-1 overflow-y-auto p-6 doc ${readOnly ? "max-w-3xl mx-auto w-full" : ""}`}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                )}
              </div>
            )}
          </div>
        )}
        </main>
      </div>
    </div>
  );
}
