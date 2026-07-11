# note-bridge

**文件就住在你的 GitHub repo。** 網頁編輯 Markdown、存檔即 commit——版本歷史、diff、協作全部交給 Git；一鍵把任何文件變成可分享的獨立網頁，或直接開成簡報。

> 概念延續我在公司主導的 AI 文件協作平台（獲 PM 部門協理指定為全部門統一工具）。公司版整合內部 Gitea 無法公開，這是以 GitHub 重新實作的公開版本。

## 核心理念：技術模糊化

PM 不需要知道什麼是 Git。他們得到的是「線上文件工具 + 一鍵分享 + 簡報模式」；
工程師得到的是「所有規格文件都是 repo 裡的 Markdown，AI 友善、可 diff、可 review」。
兩邊都用自己習慣的方式工作，中間的技術細節被藏起來——這就是 note-bridge 要橋接的東西。

## 功能

- **GitHub repo 即資料庫**：不自建儲存，文件 = repo 裡的 `.md`，每次存檔都是一個真實 commit
- **GitHub OAuth 多使用者**：訪客用自己的帳號登入、操作自己的 repo
- **分享為獨立網頁**：`/s/<token>` 公開頁面，可隨時撤銷；訪客不需要 GitHub 帳號
- **簡報模式**：同一份文件以 `---` 分頁即為投影片，鍵盤／點擊翻頁——相容 PM 的簡報習慣
- Roadmap：PM 側 AI 討論優化（RAG 知識注入）、研發側 AI 總結

## 開發

```bash
npm install
cp .env.example .env   # 填 GITHUB_CLIENT_ID / SECRET，或先填 DEV_PAT 跳過 OAuth
npm run dev            # server :3210 + client :5210（proxy /api）
```

## 部署

```bash
npm run build && npm start   # Express 同時服務 API 與 client/dist
```

Docker：見 `docker-compose.yml`。

## 架構

```
client (React 19 + Vite + Tailwind 4)
   │  /api proxy
server (Express + TypeScript)
   ├─ GitHub OAuth（token AES-256-GCM 加密存放）
   ├─ Contents API：list / read / write(=commit)
   └─ SQLite：sessions + share tokens（唯二不放 GitHub 的資料）
GitHub  ←── 唯一的文件儲存
```
