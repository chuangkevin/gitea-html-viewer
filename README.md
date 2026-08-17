# note-bridge

**文件就住在你的 GitHub repo。** 網頁編輯 Markdown、存檔即 commit——版本歷史、diff、協作全部交給 Git；一鍵把任何文件變成可分享的獨立網頁，或直接開成簡報。

> 概念延續我在公司主導的 AI 文件協作平台（獲 PM 部門協理指定為全部門統一工具）。公司版整合內部 Gitea 無法公開，這是以 GitHub 重新實作的公開版本。

## 核心理念：技術模糊化

PM 不需要知道什麼是 Git。他們得到的是「線上文件工具 + 一鍵分享 + 簡報模式」；
工程師得到的是「所有規格文件都是 repo 裡的 Markdown，AI 友善、可 diff、可 review」。
兩邊都用自己習慣的方式工作，中間的技術細節被藏起來——這就是 note-bridge 要橋接的東西。

## 功能

- **Git repo 即資料庫**：不自建儲存，文件 = repo 裡的 `.md`，每次存檔都是一個真實 commit
- **GitHub / GitLab 皆可**：貼上 repo 網址自動判斷來源（`github.com/…` 或 `gitlab.com/…`）
- **OAuth 多使用者**：訪客用自己的帳號登入、操作自己的 repo（GitHub、GitLab 各自的 OAuth App）
- **公開 repo 免登入**：public repo 直接讀、直接放簡報；private 或要編輯時才右上角登入
- **分享為獨立網頁**：`/s/<token>` 公開頁面，可隨時撤銷；訪客不需要帳號
- **內部短網址**：管理員可建立 `https://note.ia/go/<alias>`，集中檢視、改目標、啟用/停用；只做 redirect，不增加存取權
- **簡報模式**：同一份文件以 `---` 分頁即為投影片，鍵盤／點擊翻頁——相容 PM 的簡報習慣
- **HTML 預覽**：支援一般靜態站及常見 vanilla Vite 原始碼預覽；bare dependencies 由瀏覽器透過 esm.sh 載入，Server 不執行 repo build
- Roadmap：PM 側 AI 討論優化（RAG 知識注入）、研發側 AI 總結

## 開發

```bash
npm install
cp .env.example .env   # 填 GITHUB_* 和／或 GITLAB_* OAuth（兩邊都是選配）
npm run dev            # server :3210 + client :5210（proxy /api）
```

## 部署

```bash
npm run build && npm start   # Express 同時服務 API 與 client/dist
```

Docker：見 `docker-compose.yml`。

## 內部短網址

管理員可在 `/admin` 的「內部短網址」區建立 `/go/<alias>` 連結，也可在工作區目前文件或資料夾的分享動線直接建立。alias 可自訂，規則為小寫英數與 hyphen，長度 2-48；留空時 server 會產生短 code 並避開碰撞。

短網址目標只接受同站相對的 Note UI path，例如 `/edit/...`、`/site/...`、`/p/...`、`/present/...`。`/api`、`/raw`、`/s`、`/go`、`/admin` 等系統路徑會被拒絕。redirect 會使用保存的 target path，包括原本的 query/fragment；使用者打在 `/go/<alias>` 後面的 query string 不會被帶到目標。

`/go/<alias>` 只允許導向本站既有 UI，且回應不會被快取；所以重新指向或停用會立即生效。短網址不賦予任何讀取或寫入權限。被導向的頁面仍依原本 Note、repo、公開分享或登入權限判斷能不能開啟。
## 相關文件
- [部署與 repo 存取模式](DEPLOY.md)
- [建立排程同步看板 how-to](docs/排程同步看板-how-to.md) —— 以客戶 POC 看板為範本，教你建一條自己的排程同步

## 架構

```
client (React 19 + Vite + Tailwind 4)
   │  /api proxy
server (Express + TypeScript)
   ├─ Provider 抽象層（providers.ts）：GitHub / GitLab 各一實作
   ├─ OAuth（GitHub / GitLab，token AES-256-GCM 加密存放）
   ├─ list / read / write(=commit) / raw
   └─ SQLite：sessions + share tokens + internal short links（不放 repo 的資料）
GitHub / GitLab repo  ←── 唯一的文件儲存
```

## 新增 provider

`server/src/providers.ts` 定義 `Provider` 介面與 `parseRepoInput()`（貼上網址判斷來源）。
要再支援別的後端（如自架 Gitea/GitLab），實作同一介面、`registerProvider()` 註冊，
再於 `parseRepoInput` 加上該 host 的判斷即可，路由與前端不必動。
