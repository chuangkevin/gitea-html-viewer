import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type AccessMode, type Me } from "../lib/api";
import { renderMarkdown, type LinkContext } from "../lib/markdown";
import { ProviderIcon, providerLabel } from "../lib/providers";
import FileTree, { buildTree, flattenFiles } from "../components/FileTree";
import IdentityPicker from "../components/IdentityPicker";
import RepoSelector, { touchRecent } from "../components/RepoSelector";
import { kindOf } from "../components/Presenter";
import { attachBridge } from "../lib/bridge";
import { createDropClaim, insertSnippetFor, isNewFileResponse, snippetFromDragData } from "../lib/doc-paths";
import { imageSpansIn, insertOffsetForPoint, insertPointForY, moveSpanInSource } from "../lib/drop-position";
import {
  isImageMime,
  pastedImageFilename,
  pastedImagePath,
  uniqueRepoPath,
} from "../lib/paste-image";
import {
  initialViewMode,
  resolveViewMode,
  type ViewMode,
  VIEW_MODE_STORAGE_KEY,
} from "../lib/view-mode";
import type { MarkdownEditorHandle } from "../components/MarkdownEditor";
import { IMAGE_MOVE_MIME } from "../lib/drag-mime";

// CodeMirror 是整包裡最重的一塊。切成獨立 chunk，只有真的要編輯時才下載——
// 分享頁／簡報頁／唯讀預覽的訪客完全不用付這個成本。
const MarkdownEditor = lazy(() => import("../components/MarkdownEditor"));

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error" | "conflict";

/** 內容變動後閒置多久自動寫回 GitLab（毫秒）。調這個值就能改自動存檔節奏。 */
const AUTOSAVE_DELAY_MS = 3000;

const NOTE_PATH_MIME = "application/x-note-path";
// 跟 CodeMirror 圖片 widget 共用同一個值，兩邊才認得同一種拖曳
const NOTE_IMG_MOVE_MIME = IMAGE_MOVE_MIME;
const MAX_SINGLE = 20 * 1024 * 1024;

/** 這次拖曳是不是「從檔案樹拖 repo 內的檔案」。 */
function isInternalPathDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(NOTE_PATH_MIME);
}

/** 這次拖曳是不是「拖動文件裡已經存在的圖片」（＝移動，不是新增）。 */
function isImageMoveDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(NOTE_IMG_MOVE_MIME);
}

/** 這次拖曳是不是「從別的分頁拖網址」（且不是 OS 檔案）。 */
function isUrlDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types);
  return !types.includes("Files") && !types.includes(NOTE_PATH_MIME) && types.includes("text/uri-list");
}

function isNewFileLoadError(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown };
  return (typeof err.status === "number" && isNewFileResponse(err.status)) || err.code === "not_found";
}

/**
 * 主工作區。設計原則：public repo 誰都能直接讀（不登入 = 唯讀模式），
 * 需要編輯或讀 private 時才走右上角登入。
 *
 * 團隊模式（server 有成員清單）時另有一條路：不必個人 OAuth，
 * 在 header 選「你是誰」即可用該成員的 token 讀寫，commit 記在該成員名下。
 */
export default function Workspace() {
  const params_ = useParams();
  const provider = params_.provider || "";
  const project = params_.project || "";
  const hasRepo = Boolean(provider && project);
  const navigate = useNavigate();
  const projectPath = project; // react-router 已解碼；GitLab 可含巢狀群組
  const refPath = `${provider}/${encodeURIComponent(projectPath)}`; // 路由/API 用
  const repoLeaf = projectPath.split("/").pop() || projectPath;
  const [repoSelectorCollapsed, setRepoSelectorCollapsed] = useState(false);
  const [params, setParams] = useSearchParams();
  const activePath = params.get("f") || "";

  const [me, setMe] = useState<Me | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("login");
  const [guestName, setGuestName] = useState("");
  const [needLogin, setNeedLogin] = useState(false);
  const [content, setContent] = useState("");
  const [sha, setSha] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>("clean");
  const [view, setView] = useState<ViewMode>(() => {
    let stored: string | null = null;
    try {
      stored = typeof window !== "undefined" ? window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) : null;
    } catch {
      stored = null;
    }
    const isDesktopNow = typeof window !== "undefined" ? window.innerWidth >= 1024 : true;
    return initialViewMode(stored, isDesktopNow);
  });
  const [error, setError] = useState("");
  const [newFile, setNewFile] = useState("");
  const [shareUrl, setShareUrl] = useState<{ url: string; slidesUrl: string } | null>(null);
  const [presentMode, setPresentMode] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [rawGrant, setRawGrant] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [activeFolder, setActiveFolder] = useState("");
  const [reloadKey, setReloadKey] = useState(0); // 換身分後強制重讀檔案樹與檔案內容

  // 自動存檔用。pendingSaveRef ＝「還沒成功寫回 GitLab 的快照」。
  // 用 ref 不用 state：切換檔案時 effect cleanup 必須拿得到「上一個檔案」的內容才能 flush。
  // 拖到預覽窗格上時的視覺回饋（預覽是渲染後 HTML，沒有 caret，要讓使用者知道放得進去）
  const [previewDropActive, setPreviewDropActive] = useState(false);
  const pendingSaveRef = useRef<{ path: string; content: string; sha?: string } | null>(null);
  const savingRef = useRef(false);
  // render 期間直接賦值，讓 async callback 永遠讀得到最新值
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const shaRef = useRef(sha);
  shaRef.current = sha;
  const contentRef = useRef(content);
  contentRef.current = content;
  const [dirViewMode, setDirViewMode] = useState<"continuous" | "list">("continuous");
  const [folderMdContents, setFolderMdContents] = useState<Record<string, string>>({});
  const [loadedCount, setLoadedCount] = useState(0);
  const [isFolderLoading, setIsFolderLoading] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [copiedSite, setCopiedSite] = useState(false);
  const [shortLinkOpen, setShortLinkOpen] = useState(false);
  const [shortAlias, setShortAlias] = useState("");
  const [shortLabel, setShortLabel] = useState("");
  const [shortLinkResult, setShortLinkResult] = useState<{ goUrl: string } | null>(null);
  const [shortLinkError, setShortLinkError] = useState("");
  const [shortLinkSaving, setShortLinkSaving] = useState(false);
  const [copiedShortLink, setCopiedShortLink] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [uploadFailures, setUploadFailures] = useState<Array<{ path: string; error: string }> | null>(null);
  const dragCounter = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true
  );

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    setIsDesktop(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    const onClickOutside = (e: MouseEvent | TouchEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current &&
        !menuBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("touchstart", onClickOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("touchstart", onClickOutside);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

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
    if (!hasRepo) {
      setAccessReady(true);
      return;
    }
    setNeedLogin(false);
    api
      .files(refPath)
      .then((r) => {
        setFiles(r.files.map((f) => f.path));
        setCanWrite(r.canWrite);
        setIsPrivate(r.private);
        if (r.access) setAccessMode(r.access);
        if (r.guestName !== undefined && r.guestName !== null) setGuestName(r.guestName);
        touchRecent(provider, projectPath);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      })
      .finally(() => setAccessReady(true));
  }, [refPath, reloadKey, hasRepo, provider, projectPath]);

  useEffect(() => {
    setAccessReady(false);
  }, [refPath, reloadKey, hasRepo]);

  useEffect(loadFiles, [loadFiles]);

  useEffect(() => {
    if (files !== null && hasRepo) {
      api.setLastRepo(provider, projectPath, activePath).catch(() => {});
    }
  }, [provider, projectPath, activePath, files, hasRepo]);

  const activeKind = activePath ? kindOf(activePath) : null;

  const hasIdentity = Boolean(me?.login || me?.team?.selected);
  const identityId = me?.login
    ? `${me.provider}:${me.login}`
    : me?.team?.selected
    ? `ident:${me.team.selected.name}`
    : null;

  useEffect(() => {
    if (!isPrivate || accessMode === "open" || !hasIdentity || rawGrant) return;
    api.rawGrant(provider, projectPath).then((r) => setRawGrant(r.grant)).catch(() => {});
  }, [isPrivate, accessMode, hasIdentity, rawGrant, provider, projectPath]);

    // open 模式的 repo 本來就免登入可讀，掛 grant 只會多一個會過期的東西，
  // 讓連結在 grant 失效後反而打不開。只有真正需要授權時才掛。
  const needsGrant = isPrivate && accessMode !== "open";
  const rawBase = needsGrant && rawGrant ? `/rawt/${rawGrant}` : "/raw";

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
        // 遠端內容已載入，這個路徑的舊 pending 失效
        if (pendingSaveRef.current?.path === activePath) pendingSaveRef.current = null;
      })
      .catch((e) => {
        if (isNewFileLoadError(e)) {
          const pending = pendingSaveRef.current?.path === activePath ? pendingSaveRef.current : null;
          setContent(pending?.content ?? "");
          setSha(undefined);
          if (pending) setSave("dirty");
          return;
        }
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [refPath, activePath, reloadKey]);

  const filesRef = useRef<string[] | null>(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const meRef = useRef<Me | null>(me);
  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    if (activeKind !== "html" || !iframeRef.current) return;
    const iframe = iframeRef.current;
    const cleanup = attachBridge({
      iframe,
      whoami: async () => {
        let currentMe = meRef.current;
        if (!currentMe) {
          currentMe = await api.me().catch(() => null);
        }
        if (currentMe?.login) {
          return { name: currentMe.login, source: "oauth" };
        }
        if (currentMe?.team?.selected?.name) {
          return { name: currentMe.team.selected.name, source: "identity" };
        }
        return { name: "", source: "anonymous" };
      },
      readFile: async (path: string) => {
        const file = await api.readFile(refPath, path);
        return file.content;
      },
      saveFile: async (path: string, contentStr?: string, contentBase64?: string) => {
        const msg = `更新 ${path}（via 互動頁）`;
        const targetSha = path === activePath ? sha : undefined;
        const res = await api.saveFile(refPath, path, contentStr, targetSha, msg, contentBase64);
        if (path === activePath && contentStr !== undefined) {
          setSha(res.sha);
          setContent(contentStr);
          // 已經寫回遠端了，清掉這個路徑的 pending，避免自動存檔再送一次舊內容
          if (pendingSaveRef.current?.path === path) pendingSaveRef.current = null;
          setSave("saved");
          setTimeout(() => setSave((s) => (s === "saved" ? "clean" : s)), 2000);
        }
      },
      openPath: (path: string) => {
        setActiveFolder("");
        setParams({ f: path });
      },
      listFiles: async (targetPath: string, recursive?: boolean) => {
        let fileList = filesRef.current;
        if (!fileList) {
          try {
            const r = await api.files(refPath);
            fileList = r.files.map((f) => f.path);
          } catch {
            return [];
          }
        }

        const normalized = targetPath.trim().replace(/^\/+|\/+$/g, "");
        const cleanPath = normalized === "." ? "" : normalized;
        const prefix = cleanPath ? cleanPath + "/" : "";

        if (!recursive) {
          const dirMap = new Map<string, { name: string; path: string; isDir: boolean; depth: number }>();

          for (const f of fileList) {
            if (prefix === "" || f.startsWith(prefix)) {
              const rel = prefix ? f.slice(prefix.length) : f;
              if (!rel) continue;
              const parts = rel.split("/");
              if (parts.length === 1) {
                const name = parts[0];
                dirMap.set(f, { name, path: f, isDir: false, depth: 0 });
              } else {
                const subName = parts[0];
                const subPath = cleanPath ? `${cleanPath}/${subName}` : subName;
                if (!dirMap.has(subPath)) {
                  dirMap.set(subPath, { name: subName, path: subPath, isDir: true, depth: 0 });
                }
              }
            }
          }

          const result = Array.from(dirMap.values());
          result.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
          });

          return result;
        }

        interface TreeItem {
          name: string;
          path: string;
          isDir: boolean;
          depth: number;
          children?: Map<string, TreeItem>;
        }

        const rootChildren = new Map<string, TreeItem>();

        for (const f of fileList) {
          if (prefix !== "" && !f.startsWith(prefix)) continue;
          const rel = prefix ? f.slice(prefix.length) : f;
          if (!rel) continue;
          const parts = rel.split("/");

          let currentMap = rootChildren;
          let currentPathPrefix = cleanPath;

          for (let i = 0; i < parts.length; i++) {
            const partName = parts[i];
            const isLast = i === parts.length - 1;
            const itemPath = currentPathPrefix ? `${currentPathPrefix}/${partName}` : partName;
            const isDir = !isLast;

            let item = currentMap.get(partName);
            if (!item) {
              item = {
                name: partName,
                path: itemPath,
                isDir,
                depth: i,
                children: isDir ? new Map() : undefined,
              };
              currentMap.set(partName, item);
            }
            if (isDir) {
              currentMap = item.children!;
              currentPathPrefix = itemPath;
            }
          }
        }

        function flattenTree(map: Map<string, TreeItem>): Array<{ name: string; path: string; isDir: boolean; depth: number }> {
          const nodes = Array.from(map.values());
          nodes.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
          });

          const res: Array<{ name: string; path: string; isDir: boolean; depth: number }> = [];
          for (const node of nodes) {
            res.push({
              name: node.name,
              path: node.path,
              isDir: node.isDir,
              depth: node.depth,
            });
            if (node.isDir && node.children) {
              res.push(...flattenTree(node.children));
            }
          }
          return res;
        }

        return flattenTree(rootChildren);
      },
    });
    return cleanup;
  }, [activeKind, activePath, refPath, sha, setParams]);

  /**
   * 把一份快照寫回 GitLab。快照而非直接讀 state，是因為切檔案 / 關頁面時
   * 要能把「上一個檔案」的內容補存回去。
   */
  async function saveSnapshot(
    snap: { path: string; content: string; sha?: string },
    opts?: { force?: boolean }
  ) {
    if (!snap.path || !canWrite) return;
    if (savingRef.current) return; // 已有 in-flight，結束後 finally 會重新 arm
    const isCurrent = () => snap.path === activePathRef.current;
    savingRef.current = true;
    if (isCurrent()) setSave("saving");
    try {
      const r = await api.saveFile(refPath, snap.path, snap.content, opts?.force ? undefined : snap.sha);
      if (pendingSaveRef.current?.path === snap.path) {
        if (pendingSaveRef.current.content === snap.content) {
          pendingSaveRef.current = null; // 完整寫回了
        } else {
          // 存檔期間又打了字：保留 pending，但要換成新的 sha，否則下一次會誤判 409
          pendingSaveRef.current.sha = r.sha;
        }
      }
      if (isCurrent()) {
        setSha(r.sha);
        // 存檔期間又打字的話 save 已經是 "dirty"，不要蓋掉
        setSave((s) => (s === "saving" ? "saved" : s));
        setTimeout(() => setSave((s) => (s === "saved" ? "clean" : s)), 2000);
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        // 遠端已被別人改過。停掉自動存檔，交給使用者決定，不要自動覆蓋別人的 commit。
        setSave("conflict");
        setError("這個檔案在遠端已被改過，自動存檔已暫停。請選擇「重新載入遠端版本」或「用我的版本覆蓋」。");
      } else {
        setSave("error");
        setError(String(err.message || e));
      }
    } finally {
      savingRef.current = false;
      // 還有沒寫回的內容 → 重新標 dirty，讓 debounce effect 再排一次
      if (pendingSaveRef.current) {
        setSave((s) => (s === "conflict" || s === "error" ? s : "dirty"));
      }
    }
  }

  /** 手動存檔（按鈕 / Cmd+S）。 */
  async function handleSave() {
    const snap = pendingSaveRef.current ?? { path: activePath, content, sha };
    await saveSnapshot(snap);
  }

  /** 409 衝突：放棄本機修改，重新載入遠端版本。 */
  function handleConflictReload() {
    pendingSaveRef.current = null;
    setError("");
    setSave("clean");
    setReloadKey((k) => k + 1);
  }

  /** 409 衝突：用本機版本覆蓋遠端（先取最新 sha 再寫）。 */
  async function handleConflictOverwrite() {
    if (!activePath) return;
    setError("");
    try {
      const cur = await api.readFile(refPath, activePath);
      setSha(cur.sha);
      const snap = pendingSaveRef.current ?? { path: activePath, content, sha: cur.sha };
      snap.sha = cur.sha;
      pendingSaveRef.current = snap;
      setSave("dirty");
      await saveSnapshot(snap);
    } catch (e) {
      setSave("error");
      setError(String((e as Error).message || e));
    }
  }

  /**
   * 把一段 markdown 插進文件原始碼。
   * at 是插入位置（字元 offset）；atEnd 強制插在文件末尾（拖到預覽窗格時用，
   * 因為預覽是渲染後的 HTML，沒有 caret 可以對應）。都不給就用目前游標位置。
   *
   * 刻意不切換檢視模式：在預覽模式拖入時要留在預覽，讓使用者當下就看到圖，
   * 而不是被踢去 split。預覽是 content 的 useMemo，setContent 後會自動重繪。
   *
   * 插完要同步 pendingSaveRef，自動存檔才吃得到。
   */
  const insertIntoEditor = useCallback(
    (snippet: string, opts?: { at?: number; atEnd?: boolean }) => {
      if (!canWrite) return;
      const el = editorRef.current;
      const cur = contentRef.current;
      const at = opts?.at;
      const pos = opts?.atEnd
        ? cur.length
        : typeof at === "number" && at >= 0 && at <= cur.length
          ? at
          : el
            ? el.getSelectionStart()
            : cur.length;

      // 讓插入的內容自成一段：前後視情況補換行
      const before = cur.slice(0, pos);
      const after = cur.slice(pos);
      const needLeadingNl = before.length > 0 && !before.endsWith("\n");
      const needTrailingNl = after.length > 0 && !after.startsWith("\n");
      const block = `${needLeadingNl ? "\n" : ""}${snippet}${needTrailingNl ? "\n" : ""}`;
      const next = before + block + after;
      const caret = pos + block.length;

      contentRef.current = next;
      setContent(next);
      pendingSaveRef.current = { path: activePathRef.current, content: next, sha: shaRef.current };
      setSave((s) => (s === "conflict" ? s : "dirty"));

      // 只有原本就看得到編輯器時才移動游標；純預覽模式沒有編輯器，不做任何事
      setTimeout(() => {
        const t = editorRef.current;
        if (t) {
          t.focus();
          t.setSelection(caret);
        }
      }, 0);
      return caret;
    },
    [canWrite]
  );

  /** 一次換掉整份內容（圖片移動用）。存檔簿記與 insertIntoEditor 相同。 */
  const replaceContent = useCallback((next: string) => {
    if (!canWrite) return;
    setContent(next);
    pendingSaveRef.current = { path: activePathRef.current, content: next, sha: shaRef.current };
    setSave((s) => (s === "conflict" ? s : "dirty"));
  }, [canWrite]);

  /**
   * 從一次拖放事件取出要插入的 markdown。
   * 檔案樹的檔案 → 圖片 `![]()`／其他 `[]()`；外部網址 → 裸網址（預覽會渲染成卡片）。
   * 取不到就回 null。
   */
  const snippetFromDrag = useCallback((dt: DataTransfer): string | null => {
    // 本站的 /raw、/rawt/<grant> 資產 URL（例如抓著檔案樹的下載 icon 拖出來的原生連結拖曳）
    // 會在 snippetFromDragData 裡被還原成 repo 相對路徑——markdown 不可以留下主機名或 grant token。
    return snippetFromDragData(
      {
        notePath: isInternalPathDrag(dt) ? dt.getData(NOTE_PATH_MIME) : "",
        uriList: dt.getData("text/uri-list"),
        plain: dt.getData("text/plain"),
      },
      typeof window !== "undefined" ? window.location.origin : undefined
    );
  }, []);

  /** 同一個原生 drop 事件只讓一個 handler 插入內容（<main>／預覽窗格／編輯區都綁在同一棵 DOM 上）。 */
  const claimDrop = useRef(createDropClaim()).current;

  /** 拖到編輯區：檔案樹的檔案→插入 markdown；外部網址→插入裸網址。 */
  const handleEditorDrop = useCallback(
    (e: DragEvent): boolean => {
      const dt = e.dataTransfer;

      // 拖動文件裡既有的圖片＝移動（刪原處＋插新處，總數不變）
      if (isImageMoveDrag(dt)) {
        e.preventDefault();
        e.stopPropagation();
        if (!claimDrop(e)) return true;
        if (!canWrite) {
          setError("唯讀，無法移動");
          return true;
        }
        const raw = dt?.getData(NOTE_IMG_MOVE_MIME) ?? "";
        const [rawStart, rawEnd] = raw.split(",");
        const start = Number(rawStart);
        const end = Number(rawEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return true;
        const at = editorRef.current?.posAtCoords(e.clientX, e.clientY) ?? contentRef.current.length;
        replaceContent(moveSpanInSource(contentRef.current, { start, end }, at));
        return true;
      }

      const internal = isInternalPathDrag(dt);
      const urlDrag = isUrlDrag(dt);
      if (!internal && !urlDrag) return false; // OS 檔案拖放 → 讓既有的上傳流程接手
      e.preventDefault();
      e.stopPropagation();
      if (!claimDrop(e)) return true; // 這次拖放已經被別的 handler 插過了
      if (!canWrite) {
        setError("唯讀，無法插入");
        return true;
      }

      const snippet = dt ? snippetFromDrag(dt) : null;
      if (!snippet) return true;
      // CodeMirror 能把放開的螢幕座標換成精確的原始碼 offset，所以插在「放開的地方」
      // 而不是「目前游標」。算不出來（例如放在最後一行下方的空白）才退回游標。
      const at = editorRef.current?.posAtCoords(e.clientX, e.clientY) ?? null;
      if (at === null) insertIntoEditor(snippet);
      else insertIntoEditor(snippet, { at });
      return true;
    },
    [canWrite, claimDrop, insertIntoEditor, replaceContent, snippetFromDrag]
  );

  const handleEditorDragOver = useCallback((e: DragEvent) => {
    const dt = e.dataTransfer;
    const move = isImageMoveDrag(dt);
    if (!move && !isInternalPathDrag(dt) && !isUrlDrag(dt)) return;
    e.preventDefault();
    // 不 stopPropagation：CM 的 dropCursor 要靠同一個事件更新落點指示
    if (dt) dt.dropEffect = move ? "move" : "copy";
  }, []);

  /**
   * 拖到「預覽窗格」：預覽是渲染後的 HTML，沒有 caret 可對應放開位置，
   * 所以一律插在文件末尾，並留在預覽模式——setContent 後 html 這個 useMemo
   * 會重算，圖片當下就出現在預覽裡。
   */
  /** 拖曳落點指示器的節點與目前指示的 offset；純視覺，不碰 markdown 原始碼。 */
  const dropGapRef = useRef<HTMLDivElement | null>(null);
  const dropGapOffsetRef = useRef<number | null>(null);
  const dropGapRafRef = useRef<number | null>(null);

  /** 移除落點指示器。drop／真的離開預覽／拖曳取消都要呼叫，不可殘留。 */
  const clearDropGap = useCallback(() => {
    if (dropGapRafRef.current !== null) {
      cancelAnimationFrame(dropGapRafRef.current);
      dropGapRafRef.current = null;
    }
    dropGapRef.current?.remove();
    dropGapRef.current = null;
    dropGapOffsetRef.current = null;
  }, []);

  /**
   * 依游標 Y 更新落點指示器。用的是跟 drop 完全同一個 insertPointForY，
   * 所以「拖曳時看到的落點」＝「放開後插入的位置」。
   * dragover 觸發很密：用 requestAnimationFrame 節流，而且落點沒變就不動 DOM。
   */
  const updateDropGap = useCallback((container: HTMLElement, clientY: number) => {
    if (dropGapRafRef.current !== null) return;
    dropGapRafRef.current = requestAnimationFrame(() => {
      dropGapRafRef.current = null;
      const els = Array.from(container.querySelectorAll<HTMLElement>("[data-src-start]"));
      if (els.length === 0) return;
      const blocks = els.map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, start: Number(el.dataset.srcStart), end: Number(el.dataset.srcEnd) };
      });
      if (blocks.some((b) => Number.isNaN(b.start) || Number.isNaN(b.end))) return;
      const point = insertPointForY(blocks, clientY, contentRef.current.length);
      if (point.index < 0) return;
      if (dropGapOffsetRef.current === point.offset && dropGapRef.current?.isConnected) return;
      let gap = dropGapRef.current;
      if (!gap) {
        gap = document.createElement("div");
        gap.className = "nb-drop-gap";
        dropGapRef.current = gap;
      }
      const target = els[point.index];
      if (point.position === "before") target.before(gap);
      else target.after(gap);
      dropGapOffsetRef.current = point.offset;
    });
  }, []);

  const handlePreviewDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isInternalPathDrag(e.dataTransfer) && !isUrlDrag(e.dataTransfer) && !isImageMoveDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isImageMoveDrag(e.dataTransfer) ? "move" : "copy";
    setPreviewDropActive(true);
    updateDropGap(e.currentTarget, e.clientY);
  }, [updateDropGap]);

  const handlePreviewDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isInternalPathDrag(e.dataTransfer) && !isUrlDrag(e.dataTransfer) && !isImageMoveDrag(e.dataTransfer)) return;
    e.stopPropagation();
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return; // 只是移到子元素，不算離開
    setPreviewDropActive(false);
    clearDropGap();
  }, [clearDropGap]);

  /**
   * 從預覽窗格拖動「文件裡已經存在的圖片」＝移動，不是新增。
   * 先用 data-src-start/end 找到這張圖所在的 top-level 區塊，
   * 再用 imageSpansIn 找出區塊內第 n 張圖對應的原始碼範圍（n＝這張圖在該區塊裡的順序），
   * 把範圍寫進 dataTransfer；找不到就不設，讓它退回瀏覽器原生行為。
   */
  const handlePreviewDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const img = (e.target as HTMLElement | null)?.closest?.("img");
    if (!img) return;
    const block = img.closest("[data-src-start]") as HTMLElement | null;
    if (!block) return;
    const start = Number(block.dataset.srcStart);
    const end = Number(block.dataset.srcEnd);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    const index = Array.from(block.querySelectorAll("img")).indexOf(img as HTMLImageElement);
    if (index < 0) return;
    const spans = imageSpansIn(contentRef.current, start, end);
    const span = spans[index];
    if (!span) return;
    e.dataTransfer.setData(NOTE_IMG_MOVE_MIME, `${span.start},${span.end}`);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  /**
   * 從預覽窗格的放開座標換算出「要插在 markdown 原始碼的哪個 offset」。
   * 預覽的每個 top-level 區塊在 renderMarkdown 時被標上 data-src-start / data-src-end，
   * 這裡把它們的畫面位置收集起來交給 insertOffsetForPoint 判斷。
   * 沒有標記（例如渲染時對不上）就回 null，呼叫端 fallback 成插在末尾。
   */
  const previewInsertOffset = useCallback((container: HTMLElement, clientY: number): number | null => {
    const marked = Array.from(container.querySelectorAll<HTMLElement>("[data-src-start]"));
    if (marked.length === 0) return null;
    const blocks = marked.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        start: Number(el.dataset.srcStart),
        end: Number(el.dataset.srcEnd),
      };
    });
    if (blocks.some((b) => Number.isNaN(b.start) || Number.isNaN(b.end))) return null;
    return insertOffsetForPoint(blocks, clientY, contentRef.current.length);
  }, []);

  const handlePreviewDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const dt = e.dataTransfer;
      if (!isInternalPathDrag(dt) && !isUrlDrag(dt) && !isImageMoveDrag(dt)) return; // OS 檔案 → 交給既有的上傳流程
      e.preventDefault();
      e.stopPropagation(); // 別讓 <main> 再處理一次，否則會插入兩份
      clearDropGap(); // 指示器是視覺的，插入前先移掉，免得影響任何量測
      setPreviewDropActive(false);
      if (!claimDrop(e.nativeEvent)) return; // 保險：就算冒泡擋不住也只插一次
      if (!canWrite) {
        setError("唯讀，無法插入");
        return;
      }
      if (isImageMoveDrag(dt)) {
        const raw = dt.getData(NOTE_IMG_MOVE_MIME);
        const [s, en] = raw.split(",").map(Number);
        if (Number.isNaN(s) || Number.isNaN(en)) return;
        const at = previewInsertOffset(e.currentTarget, e.clientY);
        const next = moveSpanInSource(contentRef.current, { start: s, end: en }, at ?? contentRef.current.length);
        if (next !== contentRef.current) replaceContent(next);
        return;
      }
      const snippet = snippetFromDrag(dt);
      if (!snippet) return;
      const at = previewInsertOffset(e.currentTarget, e.clientY);
      if (at === null) insertIntoEditor(snippet, { atEnd: true });
      else insertIntoEditor(snippet, { at });
    },
    [canWrite, claimDrop, clearDropGap, insertIntoEditor, previewInsertOffset, replaceContent, snippetFromDrag]
  );

  async function handleCreate() {
    let p = newFile.trim();
    if (!p) return;
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    setNewFile("");
    setFiles((f) => (f ? [...f, p] : [p]));
    setParams({ f: p });
    const initial = `# ${p.replace(/\.md$/i, "").split("/").pop()}\n\n`;
    setContent(initial);
    setSha(undefined);
    pendingSaveRef.current = { path: p, content: initial, sha: undefined };
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
    const g = needsGrant && rawGrant ? `&grant=${rawGrant}` : "";
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

  // 自動存檔：內容變動後閒置 AUTOSAVE_DELAY_MS 就 commit 回 GitLab。
  // conflict / error 狀態不自動重試，避免一直打 GitLab 或覆蓋別人的修改。
  useEffect(() => {
    if (save !== "dirty") return;
    if (!activePath || !canWrite) return;
    if (activeKind !== "md" && activeKind !== "html") return;
    const t = setTimeout(() => {
      const p = pendingSaveRef.current;
      if (p) void saveSnapshot(p);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [content, save, activePath, canWrite, activeKind]);

  // 離開頁面 / 切到別的分頁 / 視窗失焦 → 立刻補存，不等 debounce
  useEffect(() => {
    const flush = () => {
      const p = pendingSaveRef.current;
      if (p) void saveSnapshot(p);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingSaveRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }); // 刻意不給 deps：每次 render 重綁，確保閉包拿到最新的 saveSnapshot（與上面 Cmd+S effect 同樣寫法）

  // 切換檔案 / 元件卸載前，把上一個檔案還沒存的內容補回去
  useEffect(() => {
    return () => {
      const p = pendingSaveRef.current;
      if (p) void saveSnapshot(p);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  const readOnly = !canWrite;
  const effectiveView = resolveViewMode(view, { readOnly, isDesktop });

  // 「預覽」本身就是可編輯的所見即所得畫面：可寫的人在 preview 看到的是開了
  // 行內渲染的 CodeMirror，不是唯讀 HTML。唯讀訪客才走原本的 marked 預覽。
  const showEditor = effectiveView !== "preview" || canWrite;
  const showMarkedPreview =
    effectiveView === "split" || (effectiveView === "preview" && !canWrite);
  const editorLivePreview = effectiveView === "preview";

  const linkContext = useMemo<LinkContext>(
    () => ({
      provider,
      project: projectPath,
      currentPath: activePath,
      files: files || [],
      rawBase,
    }),
    [provider, projectPath, activePath, files, rawBase]
  );
  const html = useMemo(() => renderMarkdown(content, linkContext), [content, linkContext]);

  // 編輯器行內渲染的圖片路徑解析：刻意跟預覽窗格共用同一組 doc-paths 函式，
  // 才不會變成兩套相對路徑規則。
  const livePreviewContext = useMemo(
    () => (rawBase ? { provider, project: projectPath, currentPath: activePath, rawBase } : null),
    [provider, projectPath, activePath, rawBase]
  );

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

  const shouldIgnoreFile = (relPath: string): boolean => {
    const parts = relPath.split("/");
    for (const part of parts) {
      if (part === ".git" || part === "node_modules" || part === ".DS_Store") {
        return true;
      }
    }
    return false;
  };

  const uploadFilesList = async (rawItems: Array<{ relPath: string; file: File }>) => {
    if (isUploading) return;
    setUploadFailures(null);
    setError("");

    // 16. 自動略過：.git/ 底下所有檔案、.DS_Store、node_modules/
    const items = rawItems.filter((it) => !shouldIgnoreFile(it.relPath));

    if (items.length === 0) {
      setError("沒有可上傳的有效檔案（已自動過濾隱藏檔／特定目錄）");
      return;
    }

    // 15. 前端先擋掉明顯不合法的：單檔 > 20MB、總量 > 50MB、檔數 > 200
    if (items.length > 200) {
      setError(`單次上傳最多 200 個檔案（目前選擇了 ${items.length} 個檔案）`);
      return;
    }

    const MAX_TOTAL = 50 * 1024 * 1024;
    let totalSize = 0;

    for (const it of items) {
      if (it.file.size > MAX_SINGLE) {
        setError(`檔案「${it.relPath}」大小 (${(it.file.size / (1024 * 1024)).toFixed(1)}MB) 超過單檔 20MB 限制`);
        return;
      }
      totalSize += it.file.size;
    }

    if (totalSize > MAX_TOTAL) {
      setError(`上傳總量 (${(totalSize / (1024 * 1024)).toFixed(1)}MB) 超過單次 50MB 限制`);
      return;
    }

    setIsUploading(true);
    const targetDir = getCurrentDirContext();
    const payloadFiles: Array<{ path: string; contentBase64: string }> = [];

    try {
      // 14. 讀檔轉 base64
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        setUploadProgress(`正在讀取檔案 (${i + 1}/${items.length})：${it.relPath}`);

        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result as string;
            const b64 = res.includes(",") ? res.split(",")[1] : res;
            resolve(b64);
          };
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(it.file);
        });

        const fullPath = targetDir ? `${targetDir}/${it.relPath}` : it.relPath;
        payloadFiles.push({ path: fullPath, contentBase64: base64 });
      }

      setUploadProgress(`正在提交 ${payloadFiles.length} 個檔案至伺服器...`);
      const commitMsg = `docs: 上傳 ${payloadFiles.length} 個檔案`;
      const res = await api.batchUpload(refPath, payloadFiles, commitMsg);

      setUploadProgress(null);
      setIsUploading(false);

      if (res.count > 0) {
        await loadFiles();
      }

      if (res.failed && res.failed.length > 0) {
        setUploadFailures(res.failed);
      }
    } catch (err: any) {
      setUploadProgress(null);
      setIsUploading(false);
      let msg = err.message || "上傳失敗";
      if (err.status === 413 || err.code === "file_too_large") {
        msg = err.message || "檔案或總量超過大小限制";
      } else if (err.status === 401 || err.status === 403) {
        msg = "沒有寫入權限，請先登入或選擇身分";
      }
      setError(`上傳失敗：${msg}`);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const items = files.map((f) => ({ relPath: f.name, file: f }));
    uploadFilesList(items);
    e.target.value = "";
  };

  /** 真正做上傳與插入的部分（非同步）。同步的判斷留在 handleEditorPaste。 */
  const uploadPastedImages = useCallback(
    async (images: File[], insertAt: number) => {
      for (const file of images) {
        if (file.size > MAX_SINGLE) {
          setError(`檔案「${file.name || "貼上的圖片"}」大小 (${(file.size / (1024 * 1024)).toFixed(1)}MB) 超過單檔 20MB 限制`);
          return;
        }
      }

      setUploadFailures(null);
      setError("");
      setIsUploading(true);

      const targetDir = getCurrentDirContext();
      const usedPaths = [...(files || [])];
      const now = new Date();
      const payloadFiles: Array<{ path: string; contentBase64: string; filename: string }> = [];

      try {
        for (let i = 0; i < images.length; i++) {
          const file = images[i];
          const filename = pastedImageFilename(file.type, now, i);
          const fullPath = uniqueRepoPath(pastedImagePath(targetDir, filename), usedPaths);
          usedPaths.push(fullPath);
          setUploadProgress(`正在讀取貼上的圖片 (${i + 1}/${images.length})：${filename}`);

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

          payloadFiles.push({ path: fullPath, contentBase64: base64, filename });
        }

        setUploadProgress(`正在提交 ${payloadFiles.length} 張圖片至伺服器...`);
        const commitMsg =
          payloadFiles.length === 1
            ? `docs: 貼上圖片 ${payloadFiles[0].filename}`
            : `docs: 貼上 ${payloadFiles.length} 張圖片`;
        const res = await api.batchUpload(
          refPath,
          payloadFiles.map(({ path, contentBase64 }) => ({ path, contentBase64 })),
          commitMsg
        );

        setUploadProgress(null);
        setIsUploading(false);

        if (res.count > 0) {
          await loadFiles();
        }

        if (res.failed && res.failed.length > 0) {
          setUploadFailures(res.failed);
        }

        const failedPaths = new Set((res.failed || []).map((failure) => failure.path));
        let at = insertAt;
        for (const uploaded of payloadFiles) {
          if (failedPaths.has(uploaded.path)) continue;
          const snippet = insertSnippetFor(uploaded.path);
          const nextAt = insertIntoEditor(snippet, { at });
          at = typeof nextAt === "number" ? nextAt : at + snippet.length;
        }
      } catch (err: any) {
        setUploadProgress(null);
        setIsUploading(false);
        let msg = err.message || "上傳失敗";
        if (err.status === 413 || err.code === "file_too_large") {
          msg = err.message || "檔案或總量超過大小限制";
        } else if (err.status === 401 || err.status === 403) {
          msg = "沒有寫入權限，請先登入或選擇身分";
        }
        setError(`上傳失敗：${msg}`);
      }
    },
    [files, getCurrentDirContext, insertIntoEditor, loadFiles, refPath]
  );

  /**
   * CodeMirror 的 paste handler 必須**同步**回傳 boolean（true = 我們接手了），
   * 所以這裡只做同步判斷與 preventDefault，實際上傳丟給 uploadPastedImages。
   */
  const handleEditorPaste = useCallback(
    (e: ClipboardEvent): boolean => {
      const cd = e.clipboardData;
      if (!cd) return false;
      let images = Array.from(cd.files || []).filter((file) => isImageMime(file.type));
      if (images.length === 0) {
        images = Array.from(cd.items || [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => !!file && isImageMime(file.type));
      }

      // 剪貼簿沒有圖片 → 完全不攔截，純文字照瀏覽器原生行為貼上
      if (images.length === 0) return false;

      const insertAt = editorRef.current?.getSelectionStart() ?? 0;
      e.preventDefault();

      if (!canWrite) {
        setError("唯讀，無法上傳");
        return true;
      }
      if (isUploading) return true;

      void uploadPastedImages(images, insertAt);
      return true;
    },
    [canWrite, isUploading, uploadPastedImages]
  );

  const handleFolderInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const items = files.map((f) => ({
      relPath: (f as any).webkitRelativePath || f.name,
      file: f,
    }));
    uploadFilesList(items);
    e.target.value = "";
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isInternalPathDrag(e.dataTransfer) || isUrlDrag(e.dataTransfer)) return;
    dragCounter.current++;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isInternalPathDrag(e.dataTransfer) || isUrlDrag(e.dataTransfer)) return;
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

  const handleMainDragOver = (e: React.DragEvent) => {
    if (isInternalPathDrag(e.dataTransfer) || isUrlDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      return;
    }
    handleDragOver(e);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 檔案樹內部拖曳／網址拖曳不是上傳，交給編輯區的 handler 處理
    if (isInternalPathDrag(e.dataTransfer) || isUrlDrag(e.dataTransfer)) {
      setIsDragging(false);
      dragCounter.current = 0;
      return;
    }

    setIsDragging(false);
    dragCounter.current = 0;

    if (!canWrite) {
      setError("唯讀，無法上傳");
      return;
    }

    const items = e.dataTransfer.items;
    const files: { relPath: string; file: File }[] = [];
    let fallbackUsed = false;

    if (items && items.length > 0) {
      let hasEntryAPI = false;
      const readEntry = (entry: any, path: string): Promise<void> => {
        return new Promise((resolve) => {
          if (entry.isFile) {
            entry.file(
              (file: File) => {
                files.push({ relPath: path ? `${path}/${file.name}` : file.name, file });
                resolve();
              },
              () => resolve()
            );
          } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const readEntries = () => {
              dirReader.readEntries(
                (entries: any[]) => {
                  if (!entries || entries.length === 0) {
                    resolve();
                  } else {
                    Promise.all(entries.map((child: any) => readEntry(child, path ? `${path}/${entry.name}` : entry.name))).then(() => {
                      readEntries();
                    });
                  }
                },
                () => resolve()
              );
            };
            readEntries();
          } else {
            resolve();
          }
        });
      };

      const promises: Promise<void>[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item.webkitGetAsEntry === "function") {
          const entry = item.webkitGetAsEntry();
          if (entry) {
            hasEntryAPI = true;
            promises.push(readEntry(entry, ""));
          }
        }
      }

      if (hasEntryAPI) {
        await Promise.all(promises);
      } else {
        fallbackUsed = true;
        const droppedFiles = Array.from(e.dataTransfer.files || []);
        for (const f of droppedFiles) {
          files.push({ relPath: f.name, file: f });
        }
      }
    } else {
      const droppedFiles = Array.from(e.dataTransfer.files || []);
      for (const f of droppedFiles) {
        files.push({ relPath: f.name, file: f });
      }
    }

    if (fallbackUsed) {
      console.info("瀏覽器不支援 DataTransferItem.webkitGetAsEntry()，僅讀取檔案。");
    }

    if (files.length > 0) {
      await uploadFilesList(files);
    }
  };

  const handleMainDrop = (e: React.DragEvent) => {
    const dt = e.dataTransfer;
    if (isImageMoveDrag(dt)) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;
      return;
    }
    if (isInternalPathDrag(dt) || isUrlDrag(dt)) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;
      if (!claimDrop(e.nativeEvent)) return; // 預覽窗格／編輯區已經接過同一次拖放就不再插一份
      if (!canWrite) {
        setError("唯讀，無法插入");
        return;
      }
      const snippet = snippetFromDrag(dt);
      // 沒有 textarea（純預覽）時插在末尾，才不會插到看不見的地方
      if (snippet) insertIntoEditor(snippet, { atEnd: !editorRef.current });
      return;
    }
    void handleDrop(e);
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

  const currentShareTargetPath = useMemo(() => {
    if (!hasRepo || (!activePath && !params.has("dir"))) return "";
    const paramStr = params.has("dir")
      ? `?dir=${encodeURIComponent(cleanDir)}`
      : `?f=${encodeURIComponent(activePath)}`;
    return `/edit/${provider}/${encodeURIComponent(projectPath)}${paramStr}`;
  }, [hasRepo, activePath, params, cleanDir, provider, projectPath]);

  const defaultShortLabel = useMemo(() => {
    if (params.has("dir")) return cleanDir ? `${repoLeaf}/${cleanDir}/` : `${repoLeaf}/`;
    return activePath || repoLeaf;
  }, [params, cleanDir, activePath, repoLeaf]);

  useEffect(() => {
    setShortLinkResult(null);
    setShortLinkError("");
  }, [currentShareTargetPath]);

  function handleCopyShare() {
    const url = `${window.location.origin}${currentShareTargetPath}`;
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

  async function handleCreateShortLink(e: React.FormEvent) {
    e.preventDefault();
    if (!me?.admin?.is) {
      setShortLinkError("只有管理員可以建立內部短網址");
      return;
    }
    if (!currentShareTargetPath) return;
    setShortLinkSaving(true);
    setShortLinkError("");
    setShortLinkResult(null);
    try {
      const r = await api.createShortLink({
        alias: shortAlias.trim() || undefined,
        targetPath: currentShareTargetPath,
        label: shortLabel.trim() || defaultShortLabel,
      });
      setShortLinkResult({ goUrl: r.link.goUrl });
      setShortAlias("");
    } catch (err: any) {
      setShortLinkError(String(err.message || err));
    } finally {
      setShortLinkSaving(false);
    }
  }

  function handleCopyShortLink() {
    if (!shortLinkResult) return;
    void copyTextToClipboard(shortLinkResult.goUrl).then(() => {
      setCopiedShortLink(true);
      setTimeout(() => setCopiedShortLink(false), 2000);
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

      const val = contentRef.current;
      const cursorPos = editor.getSelectionStart();
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
      // 這條路徑不經過 textarea 的 onChange，要自己同步 pending 快照，否則自動存檔會漏掉這次插入
      pendingSaveRef.current = { path: activePathRef.current, content: newContent, sha: shaRef.current };
      setSave((s) => (s === "conflict" ? s : "dirty"));
      setMentionQuery(null);

      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.focus();
          editorRef.current.setSelection(newCursorPos);
        }
      }, 0);
    },
    []
  );

  /**
   * @ 選單開著時，方向鍵/Enter/Tab/Escape 要歸選單用。
   * 回傳 true = 已處理，CodeMirror 不要再吃這個鍵。
   */
  const handleEditorKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (mentionQuery !== null && filteredMentions.length > 0) {
        if (e.key === "ArrowDown") {
          setMentionIndex((i) => (i + 1) % filteredMentions.length);
          return true;
        }
        if (e.key === "ArrowUp") {
          setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          const safeIndex = Math.max(0, Math.min(mentionIndex, filteredMentions.length - 1));
          const item = filteredMentions[safeIndex];
          if (item) {
            selectMention(item);
          }
          return true;
        }
        if (e.key === "Escape") {
          setMentionQuery(null);
          return true;
        }
      }
      return false;
    },
    [mentionQuery, filteredMentions, mentionIndex, selectMention]
  );

  // ── 分割檢視：編輯區與預覽區依捲動比例雙向同步 ──
  const editorRef = useRef<MarkdownEditorHandle>(null);
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
              ← 回工作區
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh flex flex-col">
      <header className="relative border-b border-zinc-800 px-4 py-2.5 flex flex-wrap items-center gap-3 shrink-0">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="開啟選單"
          aria-expanded={sidebarOpen}
          className="lg:hidden rounded-lg border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 whitespace-nowrap shrink-0"
        >
          ☰
        </button>
        <Link to="/" className="font-mono font-bold whitespace-nowrap shrink-0">
          note<span className="text-sky-400">-bridge</span>
        </Link>
        <span className="font-mono text-[10px] text-zinc-600 hidden sm:inline whitespace-nowrap shrink-0">
          {__APP_VERSION__}-{__BUILD_SHA__}
        </span>
        {hasRepo && <span className="font-mono text-base text-zinc-500 max-w-[120px] sm:max-w-xs truncate min-w-0 shrink">{projectPath}</span>}
        {readOnly && (
          <span
            className="hidden lg:inline-flex rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 whitespace-nowrap shrink-0"
            title={
              me?.team?.enabled && !me.team.selected
                ? "先在右上角選「你是誰」才能編輯"
                : "沒有這個 repo 的寫入權限"
            }
          >
            {me?.team?.enabled && !me.team.selected && !me.login ? "唯讀 · 先選身分" : "唯讀"}
          </span>
        )}
        <div className="flex-1 min-w-0" />
        {hasRepo && activePath && (activeKind === "md" || activeKind === "html") && !readOnly && (
          <div className="flex rounded-lg border border-zinc-800 overflow-hidden text-sm shrink-0 whitespace-nowrap">
            {(isDesktop ? (["preview", "split", "edit"] as const) : (["preview", "edit"] as const)).map((v) => (
              <button
                key={v}
                onClick={() => {
                  setView(v);
                  try {
                    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
                  } catch {
                    // localStorage can throw in private browsing or blocked storage modes.
                  }
                }}
                className={`px-2.5 py-1 sm:px-3 sm:py-1.5 text-xs sm:text-sm whitespace-nowrap ${effectiveView === v ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
              >
                {v === "edit" ? "原始碼" : v === "split" ? "分割" : "預覽"}
              </button>
            ))}
          </div>
        )}
        {activePath && activeKind === "md" && (
          <button
            onClick={() => navigate(`/p/${refPath}/${activePath}`)}
            className="hidden lg:inline-flex rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 whitespace-nowrap shrink-0"
          >
            🎞️ 簡報
          </button>
        )}
        {(activePath || params.has("dir")) && (
          <div className="hidden lg:flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleCopyShare}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors whitespace-nowrap"
              title="分享＝在 note 裡開啟"
            >
              {copiedShare ? "已複製 ✓" : "🔗 分享"}
            </button>
            <button
              onClick={handleCopySite}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors whitespace-nowrap"
              title="獨立網站＝乾淨的網頁、沒有 note 介面"
            >
              {copiedSite ? "已複製 ✓" : "🌐 分享為獨立網站"}
            </button>
            {me?.admin?.is ? (
              <button
                onClick={() => setShortLinkOpen((v) => !v)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-emerald-600 hover:text-emerald-300 transition-colors whitespace-nowrap"
                title="建立 /go/alias 內部短網址"
              >
                建立短網址
              </button>
            ) : me?.admin?.enabled ? (
              <span className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-500 whitespace-nowrap" title="只有管理員可以建立內部短網址">
                短網址需管理員
              </span>
            ) : null}
          </div>
        )}
        {activePath && (activeKind === "md" || activeKind === "html") && canWrite && (
          <>
            {me?.login && (
              <button
                onClick={handleShare}
                className="hidden lg:inline-flex rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 whitespace-nowrap shrink-0"
              >
                分享 Token
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={save === "saving"}
              title="編輯後會自動存檔；這個按鈕是立即存檔"
              className={`rounded-lg px-3 py-1 sm:px-4 sm:py-1.5 text-xs sm:text-sm font-semibold disabled:opacity-50 whitespace-nowrap shrink-0 ${
                save === "conflict" ? "bg-amber-600 hover:bg-amber-500" : "bg-sky-600 hover:bg-sky-500"
              }`}
            >
              {save === "saving"
                ? "commit 中…"
                : save === "saved"
                  ? "已自動存檔 ✓"
                  : save === "dirty"
                    ? "待存檔…"
                    : save === "conflict"
                      ? "⚠️ 有衝突"
                      : "存檔（commit）"}
            </button>
          </>
        )}
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
            className="hidden lg:block bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-500 max-w-[200px] whitespace-nowrap shrink-0"
          />
        )}
        {me && !me.login && me.team?.enabled && (
          <div className="hidden lg:block shrink-0">
            <IdentityPicker team={me.team} onChange={handleIdentityChange} />
          </div>
        )}
        {me && !me.login && me.providers?.[provider as "github" | "gitlab"] && (
          <a
            href={loginUrl}
            className={
              me.team?.enabled
                ? "hidden lg:inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 whitespace-nowrap shrink-0"
                : "hidden lg:inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 whitespace-nowrap shrink-0"
            }
          >
            <ProviderIcon provider={provider} className="h-4 w-4" />
            登入
          </a>
        )}
        {me?.login && (
          <span className="hidden lg:inline-flex items-center gap-1.5 text-sm text-zinc-500 whitespace-nowrap shrink-0">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
            {me.login}
          </span>
        )}
        {me?.admin?.enabled && (
          <Link
            to="/admin"
            className="hidden lg:inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400 whitespace-nowrap shrink-0"
            title="管理控制台"
          >
            ⚙️ 管理
          </Link>
        )}

        <button
          ref={menuBtnRef}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="更多選項"
          aria-expanded={menuOpen}
          className="lg:hidden rounded-lg border border-zinc-700 px-2.5 py-1 sm:px-3 sm:py-1.5 text-sm text-zinc-300 hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 whitespace-nowrap shrink-0"
        >
          ⋯
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="lg:hidden absolute right-4 top-full mt-2 w-64 rounded-xl border border-zinc-700 bg-zinc-900 p-3 shadow-2xl z-50 flex flex-col gap-2.5"
          >
            {readOnly && (
              <div className="flex items-center justify-between px-1 py-0.5">
                <span className="text-xs text-zinc-400">權限</span>
                <span
                  className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400 whitespace-nowrap"
                  title={
                    me?.team?.enabled && !me.team.selected
                      ? "先在右上角選「你是誰」才能編輯"
                      : "沒有這個 repo 的寫入權限"
                  }
                >
                  {me?.team?.enabled && !me.team.selected && !me.login ? "唯讀 · 先選身分" : "唯讀"}
                </span>
              </div>
            )}
            {activePath && activeKind === "md" && (
              <button
                onClick={() => {
                  setMenuOpen(false);
                  navigate(`/p/${refPath}/${activePath}`);
                }}
                className="w-full text-left rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                🎞️ 簡報
              </button>
            )}
            {(activePath || params.has("dir")) && (
              <>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handleCopyShare();
                  }}
                  className="w-full text-left rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  {copiedShare ? "已複製 ✓" : "🔗 分享"}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    handleCopySite();
                  }}
                  className="w-full text-left rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  {copiedSite ? "已複製 ✓" : "🌐 分享為獨立網站"}
                </button>
                {me?.admin?.is ? (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setShortLinkOpen((v) => !v);
                    }}
                    className="w-full text-left rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-emerald-600 hover:text-emerald-300 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    建立內部短網址
                  </button>
                ) : me?.admin?.enabled ? (
                  <div className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-500 whitespace-nowrap">
                    內部短網址需管理員
                  </div>
                ) : null}
              </>
            )}
            {activePath && (activeKind === "md" || activeKind === "html") && canWrite && me?.login && (
              <button
                onClick={() => {
                  setMenuOpen(false);
                  handleShare();
                }}
                className="w-full text-left rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                分享 Token
              </button>
            )}
            {accessMode === "open" && me && !me.login && !me.team?.selected && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-400 px-1">署名：</label>
                <input
                  type="text"
                  defaultValue={guestName}
                  placeholder="你是誰？（選填，會寫進 commit）"
                  onBlur={(e) => void api.setGuestName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                      setMenuOpen(false);
                    }
                  }}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-500 whitespace-nowrap"
                />
              </div>
            )}
            {me && !me.login && me.team?.enabled && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-400 px-1">選擇身分：</label>
                <IdentityPicker
                  team={me.team}
                  onChange={() => {
                    setMenuOpen(false);
                    handleIdentityChange();
                  }}
                />
              </div>
            )}
            {me && !me.login && me.providers?.[provider as "github" | "gitlab"] && (
              <a
                href={loginUrl}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-400 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                <ProviderIcon provider={provider} className="h-4 w-4" />
                登入
              </a>
            )}
            {me?.login && (
              <div className="flex items-center gap-2 px-1 text-sm text-zinc-400 border-t border-zinc-800 pt-2">
                {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
                <span className="truncate">{me.login}</span>
              </div>
            )}
            {me?.admin?.enabled && (
              <Link
                to="/admin"
                onClick={() => setMenuOpen(false)}
                className="w-full inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-400 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                ⚙️ 管理
              </Link>
            )}
          </div>
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
      {shortLinkOpen && (
        <div className="border-b border-emerald-900/50 bg-emerald-950/30 px-4 py-3 text-sm">
          <form onSubmit={handleCreateShortLink} className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-emerald-200">建立內部短網址</span>
                <span className="text-xs text-emerald-400/80">只 redirect，不增加任何存取權</span>
              </div>
              <div className="rounded border border-emerald-900/70 bg-zinc-950/60 px-2 py-1.5 font-mono text-xs text-zinc-300 break-all">
                target: {currentShareTargetPath || "尚未選擇可分享的頁面"}
              </div>
            </div>
            <label className="min-w-0 lg:w-44 space-y-1">
              <span className="block text-xs text-emerald-300/80">Alias（可留空）</span>
              <input
                type="text"
                value={shortAlias}
                onChange={(e) => setShortAlias(e.target.value.toLowerCase())}
                placeholder="erp"
                className="w-full rounded border border-emerald-900/70 bg-zinc-950 px-3 py-2 font-mono text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="min-w-0 lg:w-56 space-y-1">
              <span className="block text-xs text-emerald-300/80">Label</span>
              <input
                type="text"
                value={shortLabel}
                onChange={(e) => setShortLabel(e.target.value)}
                placeholder={defaultShortLabel}
                className="w-full rounded border border-emerald-900/70 bg-zinc-950 px-3 py-2 text-sm text-white placeholder-zinc-600 outline-none focus:border-emerald-500"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={!currentShareTargetPath || shortLinkSaving}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap"
              >
                {shortLinkSaving ? "建立中..." : "建立"}
              </button>
              <button
                type="button"
                onClick={() => setShortLinkOpen(false)}
                className="rounded border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 whitespace-nowrap"
              >
                關閉
              </button>
            </div>
          </form>
          {shortLinkError && <div className="mt-2 text-sm text-red-300 break-all">{shortLinkError}</div>}
          {shortLinkResult && (
            <div className="mt-3 flex flex-col gap-2 rounded border border-emerald-800/70 bg-emerald-950/50 px-3 py-2 sm:flex-row sm:items-center">
              <span className="text-emerald-200 whitespace-nowrap">已建立：</span>
              <a href={shortLinkResult.goUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all font-mono text-emerald-100 underline">
                {shortLinkResult.goUrl}
              </a>
              <button
                type="button"
                onClick={handleCopyShortLink}
                className="rounded border border-emerald-700 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-900/50 whitespace-nowrap"
              >
                {copiedShortLink ? "已複製" : "Copy"}
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300 flex">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <button onClick={() => setError("")}>✕</button>
        </div>
      )}
      {save === "conflict" && (
        <div className="border-b border-amber-700 bg-amber-950/60 px-4 py-2 flex flex-wrap items-center gap-2 text-sm text-amber-200">
          <span className="flex-1 min-w-[12rem]">遠端版本較新，自動存檔已暫停。</span>
          <button
            onClick={handleConflictReload}
            className="rounded border border-amber-600 px-3 py-1 text-xs hover:bg-amber-900 whitespace-nowrap"
          >
            重新載入遠端版本（放棄我的修改）
          </button>
          <button
            onClick={() => void handleConflictOverwrite()}
            className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-500 whitespace-nowrap"
          >
            用我的版本覆蓋
          </button>
        </div>
      )}
      {uploadProgress && (
        <div className="border-b border-sky-900/50 bg-sky-950/60 px-4 py-2 text-sm text-sky-200 flex items-center gap-2 font-mono">
          <span className="animate-pulse">⏳</span>
          <span>{uploadProgress}</span>
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden fixed inset-0 bg-black/50 z-40"
          />
        )}
        {/* 左側欄 */}
        <aside
          className={`w-72 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 bg-zinc-950 fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out shadow-xl lg:shadow-none lg:relative lg:z-auto lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <RepoSelector
            currentProvider={provider}
            currentProject={projectPath}
            collapsed={repoSelectorCollapsed}
            onToggleCollapse={() => setRepoSelectorCollapsed((v) => !v)}
            identified={hasIdentity}
            identityId={identityId}
          />
          {hasRepo && (
            <div className="mt-2 mb-3 border-b border-zinc-800 pb-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-zinc-400 font-mono">
                <span>將上傳到：</span>
                <span
                  className="truncate max-w-[140px] font-semibold text-sky-400"
                  title={getCurrentDirContext() ? `${getCurrentDirContext()}/` : "根目錄 (/)"}
                >
                  {getCurrentDirContext() ? `${getCurrentDirContext()}/` : "根目錄 (/)"}
                </span>
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-1.5">
                  <label
                    className={`flex-1 min-w-[100px] cursor-pointer inline-flex items-center justify-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 hover:text-white transition-colors ${
                      isUploading ? "opacity-50 pointer-events-none" : ""
                    }`}
                  >
                    <span>⬆ 上傳檔案</span>
                    <input
                      type="file"
                      multiple
                      className="hidden"
                      disabled={isUploading}
                      onChange={handleFileInputChange}
                    />
                  </label>
                  <label
                    className={`flex-1 min-w-[100px] cursor-pointer inline-flex items-center justify-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 hover:text-white transition-colors ${
                      isUploading ? "opacity-50 pointer-events-none" : ""
                    }`}
                  >
                    <span>📁 上傳資料夾</span>
                    <input
                      type="file"
                      // @ts-ignore
                      webkitdirectory=""
                      multiple
                      className="hidden"
                      disabled={isUploading}
                      onChange={handleFolderInputChange}
                    />
                  </label>
                </div>
              )}
              {uploadFailures && uploadFailures.length > 0 && (
                <div className="rounded bg-red-950/90 border border-red-800 p-2 text-xs text-red-200 space-y-1">
                  <div className="flex items-center justify-between font-semibold">
                    <span>部分失敗 ({uploadFailures.length})：</span>
                    <button
                      onClick={() => setUploadFailures(null)}
                      className="text-red-400 hover:text-red-100 font-bold px-1"
                    >
                      ✕
                    </button>
                  </div>
                  <ul className="max-h-28 overflow-y-auto space-y-1 font-mono text-[11px]">
                    {uploadFailures.map((f, idx) => (
                      <li key={idx} className="break-all">
                        <span className="font-semibold text-red-300">{f.path}</span>: {f.error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {hasRepo && isDragging && (
            <div
              className={`absolute inset-0 z-50 flex flex-col items-center justify-center border-2 border-dashed p-4 text-center backdrop-blur-sm pointer-events-none ${
                canWrite
                  ? "border-sky-500 bg-sky-950/80 text-sky-200"
                  : "border-red-500 bg-red-950/80 text-red-200"
              }`}
            >
              <div className="text-3xl mb-1">{canWrite ? "📥" : "🔒"}</div>
              <div className="font-mono text-xs font-semibold">
                {canWrite
                  ? `放開以上傳到：${getCurrentDirContext() ? `${getCurrentDirContext()}/` : "根目錄 (/)"}`
                  : "唯讀，無法上傳"}
              </div>
              <div className="text-[10px] text-zinc-400 mt-1">支援檔案與資料夾拖放</div>
            </div>
          )}
          {hasRepo && canWrite && (
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
          {hasRepo && <div className="flex items-center justify-between mb-2">
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
          </div>}
          {!hasRepo ? null : !files ? (
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
                setSidebarOpen(false);
              }}
              onSelectFolder={(dir) => {
                setActiveFolder(dir);
                setParams({ dir });
              }}
              presentMode={presentMode}
              checked={checked}
              onCheckedChange={setChecked}
              rawBase={rawBase}
              refPath={refPath}
              onInsertFile={canWrite ? (p) => insertIntoEditor(insertSnippetFor(p)) : undefined}
            />
          )}
          {hasRepo && presentMode && (
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
          onDragOver={handleMainDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleMainDrop}
        >
          {hasRepo && isDragging && (
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
          {!hasRepo ? (
            <div className="flex-1 grid place-items-center text-center px-6">
              <div className="space-y-4">
                <p className="text-xl text-zinc-500">📂</p>
                <p className="text-zinc-500 text-base">貼上 repo 網址或從左側選擇</p>
              </div>
            </div>
          ) : params.has("dir") ? (
          <div className="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800 pb-4 mb-6">
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
                    rawBase,
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
          <div className="flex-1 flex min-w-0 min-h-0 relative overflow-hidden">
            {!accessReady && activePath ? (
              <div className="flex-1 min-w-0 min-h-0 overflow-hidden bg-zinc-950 p-4 sm:p-5">
                <div className="h-full w-full min-w-0 animate-pulse space-y-4 overflow-hidden">
                  <div className="h-4 w-2/3 max-w-full rounded bg-zinc-800/80" />
                  <div className="space-y-3">
                    <div className="h-3 w-full rounded bg-zinc-900" />
                    <div className="h-3 w-11/12 max-w-full rounded bg-zinc-900" />
                    <div className="h-3 w-4/5 max-w-full rounded bg-zinc-900" />
                  </div>
                  <div className="space-y-3 pt-4">
                    <div className="h-3 w-5/6 max-w-full rounded bg-zinc-900" />
                    <div className="h-3 w-3/4 max-w-full rounded bg-zinc-900" />
                    <div className="h-3 w-10/12 max-w-full rounded bg-zinc-900" />
                  </div>
                </div>
              </div>
            ) : (
              <>
            {showEditor && (
              <div
                className={`${effectiveView === "split" ? "w-1/2 border-r border-zinc-900" : "w-full"} min-w-0 bg-zinc-950 overflow-hidden`}
              >
              <Suspense fallback={<div className="h-full w-full bg-zinc-950" />}>
              <MarkdownEditor
                ref={editorRef}
                value={content}
                onChange={(next) => {
                  setContent(next);
                  setSave((s) => (s === "conflict" ? s : "dirty"));
                  pendingSaveRef.current = { path: activePath, content: next, sha: shaRef.current };
                }}
                onSelectionChange={updateMentionTrigger}
                onKeyDown={handleEditorKeyDown}
                onPaste={handleEditorPaste}
                onDragOver={handleEditorDragOver}
                onDrop={handleEditorDrop}
                onScroll={(scroller) => syncScroll(scroller, previewRef.current)}
                livePreviewContext={livePreviewContext}
                livePreview={editorLivePreview}
                className="h-full w-full"
              />
              </Suspense>
              </div>
            )}
            {mentionQuery !== null && filteredMentions.length > 0 && (
              <div className="absolute left-2 right-2 w-auto sm:left-6 sm:right-auto sm:w-80 max-w-[calc(100vw-1rem)] top-14 z-50 max-h-64 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
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
            {showMarkedPreview && (
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
                          href={`/site/${provider}/${encodeURIComponent(projectPath)}?f=${encodeURIComponent(activePath)}${needsGrant && rawGrant ? `&grant=${rawGrant}` : ""}`}
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
                      src={`/site/${provider}/${encodeURIComponent(projectPath)}?f=${encodeURIComponent(activePath)}${needsGrant && rawGrant ? `&grant=${rawGrant}` : ""}`}
                      /* ⚠️ 刻意不給 allow-same-origin：iframe 會是 opaque origin，能跑 JS 但碰不到 note 主站的 cookie / DOM */
                      sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads allow-top-navigation-by-user-activation"
                      className="w-full flex-1 border-0 bg-white"
                      title={activePath}
                    />
                  </div>
                ) : (
                  <div
                    ref={previewRef}
                    onScroll={() => syncScroll(previewRef.current, editorRef.current?.getScrollDOM() ?? null)}
                    onClick={handlePreviewClick}
                    onDragStart={handlePreviewDragStart}
                    onDragEnd={clearDropGap}
                    onDragOver={handlePreviewDragOver}
                    onDragLeave={handlePreviewDragLeave}
                    onDrop={handlePreviewDrop}
                    className={`flex-1 overflow-y-auto p-6 doc ${readOnly ? "max-w-3xl mx-auto w-full" : ""} ${
                      previewDropActive ? "ring-2 ring-inset ring-sky-500 bg-sky-950/20" : ""
                    }`}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                )}
              </div>
            )}
              </>
            )}
          </div>
        )}
        </main>
      </div>
    </div>
  );
}
