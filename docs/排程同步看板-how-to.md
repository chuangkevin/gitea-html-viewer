# 排程同步看板 How-To

> 以現行的「客戶 POC 看板」（`poc-sync`）為範本，引導你建立一條「外部資料來源 → 排程同步服務 → note 看板頁面」的自動化流程。  
> 參考實作位置：GitLab repo `interagent-io/global-doc` 的 `客戶POC/sync/`。

---

## 0. 這份文件是什麼

這是一份內部維運與開發手冊。如果你的團隊有外部資料來源（例如 Slack 頻道訊息、Google 日曆、Jira、外部 API 等），希望定時彙整並在 note（`https://note.ia`）上呈現即時看板，本手冊提供一套已被驗證且穩定運行的標準架構與步驟，讓你直接複製並套用至自己的專案。

---

## 1. 這套同步在做什麼（架構）

### 運作流程圖

```text
+-----------------------------------------------------------------------+
|  外部資料來源                                                          |
|  - Slack API (對話紀錄 / 討論串)                                       |
|  - Google Calendar iCal (公開/私人行程)                                |
|  - 其它外部系統 (Webhook / REST API)                                   |
+-----------------------------------+-----------------------------------+
                                    | 定期抓取 / 事件觸發
                                    v
+-----------------------------------------------------------------------+
|  同步容器：poc-sync (部署於 docker-host: 10.11.12.55)                 |
|  - 技術棧：Python 3.11 + FastAPI + Uvicorn                            |
|  - 排程：背景執行緒 (threading.Thread + while True + sleep 輪詢)      |
|  - 職責：整合資料、更新 JSON、組裝 Markdown 與 HTML 內嵌區塊          |
+-----------------------------------+-----------------------------------+
                                    | 呼叫 REST API (GET / PUT /api/file/...)
                                    v
+-----------------------------------------------------------------------+
|  note server (docker-host:8790 / https://note.ia)                     |
|  - 驗證 repo 是否處於 open 存取模式                                    |
|  - 拿 note 端設定的 GITLAB_OPEN_TOKEN 代為 commit 至 GitLab            |
+-----------------------------------+-----------------------------------+
                                    | Commit & Push (GitLab REST API v4)
                                    v
+-----------------------------------------------------------------------+
|  GitLab repo (如 interagent-io/global-doc)                            |
|  - 儲存資料真相 (data.md / customers.md) 與看板 (board.html)          |
|  - GitLab CI deploy job 偵測變更並對齊 docker-host 上的 checkout      |
+-----------------------------------+-----------------------------------+
                                    | 使用者瀏覽
                                    v
+-----------------------------------------------------------------------+
|  使用者瀏覽器開啟 https://note.ia/site/gitlab/...?f=...                |
|  - note server 即時自 GitLab API 讀取 raw HTML 內容                   |
|  - injectPreviewHead() 動態注入 <base> 與 importmap                   |
|  - 瀏覽器載入單檔 HTML，前端 Vanilla JS 解析內嵌 JSON 完成渲染        |
+-----------------------------------------------------------------------+
```

### 關鍵觀念（核心設計原則）

1. **note 不是資料庫**：
   - note 平台本身不維護業務資料庫，**所有資料的唯一真相（Single Source of Truth）是 GitLab repo 裡的檔案**（Markdown 或 JSON）。
2. **同步服務不直連 Git**：
   - 同步容器不需要安裝 git CLI，也不需要配置 SSH key 或 GitLab Token。
   - 同步服務只需**呼叫 note server 的 REST API**（`GET` / `PUT` `/api/file/...`），由 note server 取用伺服器端的 `GITLAB_OPEN_TOKEN` 代為提交 commit。這樣做確保了憑證集中管理，同步服務輕量化且無權限外洩風險。
3. **單檔 HTML + 內嵌 JSON（Zero-Build 前端）**：
   - 看板頁面是一份獨立的單檔 HTML，資料直接存放在 `<script id="embedded-data" type="application/json">...</script>` 區塊內。
   - 同步腳本以正規表達式（Regex）替換該 JSON 區塊；前端 Vanilla JS 載入時以 `JSON.parse()` 讀取並動態渲染 UI。
   - **不需要 npm build、不需要前端打包工具、不需要框架**，修改即時生效。

---

## 2. 現行實作檔案清單

以 `interagent-io/global-doc` 專案中的「客戶 POC 看板」為例，實際檔案配置如下：

| 檔案路徑 | 作用說明 |
| :--- | :--- |
| `客戶POC/customers.md` | 資料真相檔：內含 ` ```json ` 區塊，記錄 `updated` 時間與 `customers[]` 陣列。 |
| `客戶POC/customers.html` | 單檔看板 HTML：內嵌 `<script id="embedded-data">`，包含 Vanilla JS 渲染與 RWD 樣式。 |
| `客戶POC/待確認.md` | 暫存記錄：若 Slack 訊息無法比對至特定客戶時，自動 append 於此供人工查驗。 |
| `客戶POC/sync/main.py` | FastAPI 應用程式：提供 HTTP API 端點並啟動背景輪詢排程執行緒。 |
| `客戶POC/sync/sync.py` | 核心同步邏輯：實作 `run_sync()`，負責抓取 Slack 訊息、更新 JSON、打 note API 寫回。 |
| `客戶POC/sync/calendar_sync.py` | Google Calendar iCal 同步模組（選用）：定時拉取日曆行程並整合。 |
| `客戶POC/sync/reminders.py` | 定時提醒模組：於台灣工作天 11:00 與 14:00 發送 Slack 待辦提醒。 |
| `客戶POC/sync/Dockerfile` | 容器映像檔定義檔（基於 `python:3.11-slim`）。 |
| `客戶POC/sync/docker-compose.yml` | 容器編排檔：定義 port 映射、volume 掛載與環境變數。 |
| `客戶POC/sync/.env.example` | 環境變數範本檔。 |
| `客戶POC/sync/requirements.txt` | Python 相依套件清單（FastAPI, uvicorn, requests, icalendar 等）。 |
| `客戶POC/sync/README.md` | 現行服務說明與維運手冊。 |
| `.gitlab-ci.yml` | CI/CD pipeline：包含 `check-docs` 檢查與 `deploy`（含 `poc-sync` 容器自動更新）。 |

### 排程機制說明

- **非外部 Cron / 非 GitLab Schedule**：排程邏輯內建於 `main.py` 中。
- **背景執行緒輪詢**：FastAPI 透過 `@app.on_event("startup")` 啟動背景執行緒 `background_scheduler()`，內以 `threading.Thread` + `while True` + `time.sleep(60)` 每分鐘檢查一次時間戳。
- **執行間隔**：一般同步間隔由環境變數 `SYNC_INTERVAL_S` 控制，預設為 `600` 秒（10 分鐘）。
- **工作天定時提醒**：`reminders.py` 會比對當前時間，在台灣工作日的 11:00 與 14:00 觸發。國定假日資料來源為 `TW_HOLIDAY_ICS_URL` 公開 iCal；若抓取失敗則自動降級為僅排除週六週日。

### HTTP 端點（`main.py`）

| 方法與路徑 | 功能說明 | 回應格式範例 |
| :--- | :--- | :--- |
| `POST /sync` | 手動觸發立即同步 | 成功（200）：`{"ok": true, "added": 2, "unmatched": 0, "duration_s": 1.45}`<br>衝突（409）：`{"error": "already_running"}` |
| `GET /status` | 取得最近同步狀態與健康檢查 | 200：`{"last_sync": "2026-08-17T15:00:00+08:00", "last_result": {...}, "running": false}` |
| `POST /post` | 反向發送訊息至 Slack thread（POC 專用） | 成功（200）：`{"ok": true, "ts": "..."}` |
| `GET /members` | 取得快取的 Slack 成員名單清單 | 200：`{"members": [...]}` |

---

## 3. 動手前要準備什麼

在開始建置新的排程同步之前，請確認以下項目皆已就緒：

1. **GitLab Repository**：
   - 準備好存放資料檔（如 `data.md`）與看板檔（如 `board.html`）的 GitLab repo（例如 `interagent-io/global-doc` 或獨立專案）。
2. **note 管理後台設定 Repo 為 `open` 模式**：
   - 瀏覽 `https://note.ia/admin`，輸入 `ADMIN_KEY` 登入。
   - 新增目標 repo（格式為 `gitlab/<owner>%2F<repo>`），並將模式切換為 **`open`（免登入公開可編）**。若未開啟 open 模式，同步服務打 API 時會被 note 拒絕。
3. **note 端的 `GITLAB_OPEN_TOKEN` 權限**：
   - note 伺服器 `.env` 中的 `GITLAB_OPEN_TOKEN` 必須具備目標 repo 的 **Developer（含）以上權限**，且 Token Scope 必須勾選 **`api`**（因為 note 使用 GitLab REST API v4 寫檔，`write_repository` 權限不足）。
4. **docker-host SSH 連線權限**：
   - 具備連線至 `docker-host`（`10.11.12.55`）之權限，以便進行容器部署與記錄檢視。
5. **未被佔用的 Host Port**：
   - 挑選一個獨立且未被佔用的 port。
   - **注意**：`8500` 已被 `secrets.ia` 佔用，現行 POC 看板使用 `8510`。新服務請使用 `8511`、`8512` 等可用 port（可在主機上透過 `ss -ltn` 查詢）。

---

## 4. 一步步：建立一條新的排程同步

### Step 1 — 在 repo 建立資料檔與看板 HTML

在目標 repo 建立業務資料夾（例如 `專案監控/`），新增資料檔與單檔看板：

1. **資料檔（`專案監控/data.md`）**：
   ````markdown
   # 專案監控資料庫

   本檔案由排程同步服務自動維護，請勿手動隨意變更 JSON 結構。

   ```json
   {
     "updated": "2026-08-17T16:00:00+08:00",
     "items": []
   }
   ```
   ````

2. **看板 HTML（`專案監控/board.html`）**：
   ```html
   <!DOCTYPE html>
   <html lang="zh-TW">
   <head>
     <meta charset="UTF-8">
     <meta name="viewport" content="width=device-width, initial-scale=1.0">
     <title>專案監控看板</title>
     <style>
       :root { --bg: #f8fafc; --card: #ffffff; --text: #0f172a; --primary: #2563eb; }
       body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
       .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
       .btn { background: var(--primary); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
       .btn:disabled { opacity: 0.6; cursor: not-allowed; }
       .table-container { background: var(--card); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow-x: auto; /* RWD 寬表格滑動 */ }
       table { width: 100%; border-collapse: collapse; min-width: 600px; }
       th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e2e8f0; }
       th { background: #f1f5f9; font-weight: 600; }
     </style>
   </head>
   <body>
     <div class="header">
       <h1>專案監控看板</h1>
       <button id="sync-btn" class="btn" onclick="triggerSync()">立即同步</button>
     </div>
     <div id="last-updated" style="margin-bottom: 12px; color: #64748b; font-size: 14px;"></div>
     <div class="table-container">
       <table id="board-table">
         <thead>
           <tr>
             <th>ID</th>
             <th>名稱</th>
             <th>狀態</th>
           </tr>
         </thead>
         <tbody id="board-tbody"></tbody>
       </table>
     </div>

     <!-- 內嵌 JSON 資料區塊 (由同步腳本透過 Regex 定期更新) -->
     <script id="embedded-data" type="application/json">
     {
       "updated": "2026-08-17T16:00:00+08:00",
       "items": []
     }
     </script>

     <script>
       // 前端渲染邏輯
       function render() {
         const raw = document.getElementById('embedded-data').textContent;
         try {
           const data = JSON.parse(raw);
           document.getElementById('last-updated').textContent = '最後更新時間：' + (data.updated || '未知');
           const tbody = document.getElementById('board-tbody');
           tbody.innerHTML = '';
           (data.items || []).forEach(item => {
             const tr = document.createElement('tr');
             tr.innerHTML = `<td>${item.id}</td><td>${item.name}</td><td>${item.status}</td>`;
             tbody.appendChild(tr);
           });
         } catch (e) {
           console.error('JSON 解析失敗:', e);
         }
       }

       // 頁面載入時渲染
       render();

       // 手動同步觸發 (配合 Step 7 反向代理)
       async function triggerSync() {
         const btn = document.getElementById('sync-btn');
         btn.disabled = true;
         btn.textContent = '同步中...';
         try {
           const res = await fetch('/my-sync/sync', { method: 'POST' });
           if (res.ok) {
             alert('同步完成！請重新整理頁面。');
             location.reload();
           } else {
             alert('同步請求失敗 (' + res.status + ')');
           }
         } catch (err) {
           alert('連線失敗: ' + err.message);
         } finally {
           btn.disabled = false;
           btn.textContent = '立即同步';
         }
       }
     </script>
   </body>
   </html>
   ```

> **💡 RWD 提醒**：內部同仁會使用手機、平板或桌機瀏覽，寬度超過螢幕的表格容器務必加上 `overflow-x: auto`，避免破版。

---

### Step 2 — 把 repo 設為 open 模式

1. 開啟瀏覽器進入 `https://note.ia/admin`。
2. 輸入伺服器端的 `ADMIN_KEY` 登入管理介面。
3. 在 Repository 名單中新增或找到你的專案（例如 `gitlab/interagent-io%2Fglobal-doc`）。
4. 將 Access Mode（存取模式）設為 **`open`** 並儲存。

---

### Step 3 — 寫同步腳本（讀寫 note API）

建立同步核心程式碼，透過 note 伺服器的 REST API 進行讀寫：

```python
import os
import json
import logging
from urllib.parse import quote
import requests

logger = logging.getLogger(__name__)

# 注意：容器內請填寫 Docker 內網直連位址，勿使用 https://note.ia
NOTE_BASE_URL = os.environ.get("NOTE_BASE_URL", "http://10.11.12.55:8790")
PROJECT_PATH = "interagent-io/global-doc"  # 你的 GitLab 專案路徑

def _make_api_url(rel_path: str) -> str:
    """
    組裝 note API URL。
    Project Path 與檔案相對路徑皆需做 URL encode。
    """
    encoded_proj = quote(PROJECT_PATH, safe="")
    encoded_file = quote(rel_path, safe="")
    return f"{NOTE_BASE_URL}/api/file/gitlab/{encoded_proj}/{encoded_file}"

def read_note_file(rel_path: str) -> str:
    """讀取 note repo 中的檔案內容 (Timeout: 30s)"""
    url = _make_api_url(rel_path)
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("content", "")

def write_note_file(rel_path: str, content: str, commit_message: str) -> dict:
    """透過 note API 寫回檔案並觸發 commit (Timeout: 60s)"""
    url = _make_api_url(rel_path)
    payload = {
        "content": content,
        "message": commit_message
    }
    resp = requests.put(url, json=payload, timeout=60)
    resp.raise_for_status()
    return resp.json()
```

#### note server 底層路由對照
- **讀取 API**：`server/src/index.ts` 之 `app.get("/api/file/:provider/:project/*")`
- **寫入 API**：`server/src/index.ts` 之 `app.put("/api/file/:provider/:project/*")`
- **看板預覽路由**：`app.get("/site/:provider/:project")`  
  網址格式：`https://note.ia/site/gitlab/interagent-io%2Fglobal-doc?f=專案監控/board.html`  
  *運作原理*：note server 收到請求時即時向 GitLab REST API v4 取得 raw HTML，並透過 `server/src/site-preview.ts` 的 `injectPreviewHead()` 動態注入 `<base>` 與 importmap 回傳。因此**前端呈現即時對齊 GitLab 上的最新 commit**。

---

### Step 4 — 用 regex 換掉 HTML 內嵌 JSON

在寫回 HTML 看板時，使用正規表達式替換 `<script id="embedded-data">` 區塊，並嚴格執行 JSON 合法性檢驗：

```python
import re
import json

EMBEDDED_JSON_PATTERN = re.compile(
    r'(<script\s+id=["\']embedded-data["\']\s+type=["\']application/json["\']>)(.*?)(</script>)',
    re.DOTALL | re.IGNORECASE
)

MD_JSON_BLOCK_PATTERN = re.compile(
    r'(```json\s*\n)(.*?)(\n```)',
    re.DOTALL | re.IGNORECASE
)

def _assert_valid_json_block(json_str: str) -> dict:
    """確保字串是合法 JSON，防止損壞看板頁面"""
    try:
        return json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise ValueError(f"產生的 JSON 無法解析，中止寫回操作: {exc}") from exc

def update_html_embedded_data(html_content: str, new_data: dict) -> str:
    """將新的 dict 序列化後替換進 HTML 看板中"""
    formatted_json = json.dumps(new_data, ensure_ascii=False, indent=2)
    _assert_valid_json_block(formatted_json)

    if not EMBEDDED_JSON_PATTERN.search(html_content):
        raise ValueError("在 HTML 檔案中找不到 <script id=\"embedded-data\"> 區塊！")

    return EMBEDDED_JSON_PATTERN.sub(
        rf'\g<1>\n{formatted_json}\n\g<3>',
        html_content
    )

def update_markdown_json_block(md_content: str, new_data: dict) -> str:
    """將新的 dict 替換進 Markdown 的 ```json 區塊中"""
    formatted_json = json.dumps(new_data, ensure_ascii=False, indent=2)
    _assert_valid_json_block(formatted_json)

    if not MD_JSON_BLOCK_PATTERN.search(md_content):
        raise ValueError("在 Markdown 檔案中找不到 ```json 區塊！")

    return MD_JSON_BLOCK_PATTERN.sub(
        rf'\g<1>{formatted_json}\g<3>',
        md_content
    )
```

---

### Step 5 — 包成容器（Dockerfile / docker-compose.yml / .env）

在專案的 `sync/` 目錄建立容器配置：

1. **`Dockerfile`**：
   ```dockerfile
   FROM python:3.11-slim
   WORKDIR /app
   COPY requirements.txt .
   RUN pip install --no-cache-dir -r requirements.txt
   COPY . .
   EXPOSE 8500
   CMD ["python", "main.py"]
   ```

2. **`docker-compose.yml`**：
   ```yaml
   services:
     my-sync:
       build: .
       container_name: my-sync
       restart: always
       ports:
         - "${HOST_PORT:-8511}:8500"
       environment:
         STATE_DIR: /app/data
       env_file:
         - .env
       volumes:
         - ./data:/app/data
   ```

3. **`.env`（從 `.env.example` 建立）**：
   ```ini
   # 外部資料來源憑證 (請替換為你的 token/key)
   SOURCE_API_TOKEN=xoxb-your-token

   # note 伺服器直連位址 (容器內請走內網 IP，勿用 note.ia)
   NOTE_BASE_URL=http://10.11.12.55:8790

   # 排程執行間隔 (秒)
   SYNC_INTERVAL_S=600

   # 對外暴露之 Host Port (請確認未被佔用，勿使用 PORT 變數名)
   HOST_PORT=8511

   # 看板公開網址 (給人員點擊使用)
   BOARD_URL=https://note.ia/site/gitlab/interagent-io%2Fglobal-doc?f=專案監控/board.html
   ```

> **⚠️ 容器建置三要點**：
> 1. 容器內服務一律固定監聽 `8500`，由 compose 的 `HOST_PORT` 映射至外部。
> 2. `volumes` 務必掛載目錄 `./data:/app/data`，切勿直接掛載單一檔案。
> 3. `NOTE_BASE_URL` 必須填寫 `http://10.11.12.55:8790`。

---

### Step 6 — 部署到 docker-host 並讓 CI 自動重建

#### 第一次手動部署
登入 `docker-host`（`10.11.12.55`）進入專案目錄：
```bash
cd /home/interagent/<你的-repo-名>/專案監控/sync
docker compose up -d --build
docker compose logs -f my-sync
```

#### 設定 GitLab CI 自動更新（參考 global-doc 實作）
在 repo 根目錄的 `.gitlab-ci.yml` 中設定 deploy job。CI 會在檢測到 `sync/` 目錄變更時自動 rebuild 容器並進行健康檢查：

```yaml
stages:
  - check
  - deploy

deploy:
  stage: deploy
  tags:
    - dockerhost
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
  variables:
    GIT_STRATEGY: none
    DEPLOY_DIR: /home/interagent/<你的-repo-名>
  script:
    - cd $DEPLOY_DIR
    - BEFORE=$(git rev-parse HEAD)
    - git fetch --prune "https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" "+refs/heads/${CI_COMMIT_BRANCH}:refs/remotes/origin/${CI_COMMIT_BRANCH}"
    - git reset --hard "origin/${CI_COMMIT_BRANCH}"
    # 檢查 sync 目錄是否有程式碼或設定檔異動
    - |
      if git diff --name-only $BEFORE HEAD -- 專案監控/sync | grep -q .; then
        echo "偵測到 sync 目錄變更，重新建置容器..."
        cd 專案監控/sync
        docker compose up -d --build
        
        # 驗證容器 running 狀態
        CONTAINER_ID=$(docker compose ps -q my-sync)
        if [ -z "$CONTAINER_ID" ]; then
          echo "錯誤：找不到 my-sync 容器！"
          exit 1
        fi
        
        # 健康檢查：用容器內的 python 檢驗 /status 回傳 200 (python:3.11-slim 不含 curl)
        echo "等待服務健康檢查 (/status)..."
        if ! docker compose exec -T my-sync python - <<'PY'
      import sys, time
      from urllib.request import urlopen
      last_error = None
      for _ in range(10):
          try:
              with urlopen("http://127.0.0.1:8500/status", timeout=3) as response:
                  body = response.read().decode("utf-8", errors="replace")
                  if response.status == 200:
                      print(f"/status OK: {body}")
                      sys.exit(0)
                  last_error = f"HTTP {response.status}: {body}"
          except Exception as exc:
              last_error = repr(exc)
          time.sleep(3)
      print(f"/status health check failed: {last_error}", file=sys.stderr)
      sys.exit(1)
      PY
        then
          echo "健康檢查失敗，最近 log："
          docker compose logs --tail=80 my-sync || true
          exit 1
        fi
        
        # 印出當前映像檔 ID 與建立時間備查
        docker inspect --format 'Image ID: {{.Image}} Created: {{.Created}}' "$CONTAINER_ID"
      fi
```

> **📌 CI / 部署要點說明**：
> 1. **`DEPLOY_DIR` 設定**：這是 docker-host 上該 repo 的 checkout 目錄，要先由維運在 docker-host 上 clone 好並套用 `ops/deploy-perms.sh` 的權限設定。
> 2. **完整 Refspec 抓取**：`git fetch` 的 refspec 一定要寫完整（`+refs/heads/${CI_COMMIT_BRANCH}:refs/remotes/origin/${CI_COMMIT_BRANCH}`），只給 branch 名稱不會建立 remote-tracking ref `origin/<branch>`，下一行的 `git reset --hard` 會直接失敗。
> 3. **健康檢查方式**：不要用 `curl`，因為 `python:3.11-slim` 基礎映像檔沒有 curl；用容器內的 python + urllib 打 `127.0.0.1:8500/status` 最保險。
> 4. **權限前提**：部署目錄需具備 `owner=gitlab-runner`、`group=deploy` 且目錄設定 setgid（由 docker-host 上的 `ops/deploy-perms.sh` 統一配置）。
> 5. **heredoc 縮排**：`PY` 結束符必須 de-dent 到 YAML block scalar 的基準縮排，YAML 剝掉基準縮排後它才會落在行首；否則 heredoc 不會終止，整段 script 會壞掉。

---

### Step 7 — 看板頁面上的「馬上同步」按鈕（選用）

當使用者在 HTTPS 看板頁面（`https://note.ia/...`）點擊「馬上同步」按鈕時，瀏覽器會發起 fetch 請求。

#### 為什麼不能直接打 `http://10.11.12.55:8511`？
瀏覽器安全機制（Mixed Content）會**強制阻擋 HTTPS 網頁載入或請求 HTTP 資源**，且使用者無法在 UI 上手動放行。因此必須在 Nginx Proxy Manager（NPM）中新增反向代理路徑，將請求轉為同源路徑（例如 `https://note.ia/my-sync`），同時徹底解決跨來源資源共用（CORS）問題。

#### NPM 反向代理設定（在 docker-host 執行）
在 NPM 中，`note.ia` 的 Proxy Host ID 為 `4`。

1. **設定參數對照**：
   | 欄位 | 設定值 |
   | :--- | :--- |
   | Location | `/my-sync` |
   | Scheme | `http` |
   | Forward Hostname / IP | `10.11.12.55` |
   | Forward Port | `8511` |

2. **操作步驟（透過 NPM Model 層注入，無須 UI 帳密）**：
   ```bash
   # 1. 先行備份 SQLite 資料庫
   cp -a ~/stack/npm-data/database.sqlite ~/stack/npm-backup-$(date +%Y%m%d%H%M%S)

   # 2. 執行 Node.js 腳本 patch locations 陣列
   # 注意：locations 必須傳入 Object Array，切勿 JSON.stringify 成字串
   docker exec npm node -e '
   Promise.all([import("/app/models/proxy_host.js"), import("/app/internal/nginx.js")]).then(async ([m, nginx])=>{
     await m.default.query().findById(4).patch({ locations: [{
       path: "/my-sync", advanced_config: "",
       forward_scheme: "http", forward_host: "10.11.12.55", forward_port: 8511 }] });
     const row = await m.default.query().where("id",4).withGraphFetched("[certificate]").first();
     await nginx.default.configure(m.default, "proxy_host", row);
     process.exit(0);
   })'

   # 3. 驗證 Nginx 設定與服務狀態
   docker exec npm nginx -t
   curl -o /dev/null -w "%{http_code}\n" https://note.ia/
   ```

3. **前端呼叫機制**：
   前端 JS 設定 `SYNC_BASE = '/my-sync'`；若以本地 `file://` 開啟 HTML 時，可 fallback 為 `http://10.11.12.55:8511`。

---

## 5. 參數對照表

### 同步服務環境變數

| 變數名稱 | 範例值 | 說明 | 必填 |
| :--- | :--- | :--- | :---: |
| `NOTE_BASE_URL` | `http://10.11.12.55:8790` | note 伺服器內網 API 位址，容器內請直連內網 IP | 是 |
| `HOST_PORT` | `8511` | 宿主機映射之連接埠（容器內部固定監聽 8500） | 是 |
| `SYNC_INTERVAL_S` | `600` | 自動排程輪詢間隔（秒） | 否 (預設 600) |
| `STATE_DIR` | `/app/data` | 容器內部狀態資料夾路徑 | 否 |
| `BOARD_URL` | `https://note.ia/site/gitlab/...` | 給人員瀏覽的外部看板完整 URL | 否 |
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack Bot Token（如有使用 Slack 資料來源） | 依業務 |
| `BOOKING_CHANNEL_ID` | `C0ALDTJ4J2U` | 目標 Slack 頻道 ID | 依業務 |
| `GCAL_ICS_URL` | `https://calendar.google.com/.../basic.ics` | Google 日曆私人/密件 iCal 網址（等同金鑰，不可 commit） | 依業務 |
| `REMINDERS_ENABLED` | `true` | 是否開啟工作日定時提醒功能 | 否 |
| `TW_HOLIDAY_ICS_URL` | `https://calendar.google.com/.../basic.ics` | 台灣國定假日 iCal 來源，用於排除休假日 | 否 |

### note 伺服器端環境變數（參考 [DEPLOY.md](../DEPLOY.md)）

| 變數名稱 | 範例 / 預設值 | 說明 |
| :--- | :--- | :--- |
| `GITLAB_OPEN_TOKEN` | `glpat-...` | 共用寫入 Token。需為 GitLab PAT，Scope 勾 `api`，且對目標 repo 具 Developer 以上權限 |
| `ADMIN_KEY` | `your_secret_admin_key` | note 後台（`/admin`）管理員登入密碼 |
| `DEFAULT_REPO` | `gitlab/interagent-io%2Fglobal-doc` | 首頁預設導向之 repository（格式：`<provider>/<URL-encode project>`） |
| `DEFAULT_FILE` | `README.md` | 首頁預設開啟之檔案名稱 |
| `NOTE_OPEN_AUTHOR_NAME` | `note 訪客` | open 模式下透過 API commit 時所記錄的作者名稱 |
| `NOTE_OPEN_AUTHOR_EMAIL` | `note@interagent.io` | open 模式下透過 API commit 時所記錄的作者 Email |
| `GITLAB_CLIENT_ID` | `...` | GitLab OAuth 應用程式 Client ID |
| `GITLAB_CLIENT_SECRET` | `...` | GitLab OAuth 應用程式 Client Secret |
| `GITLAB_FALLBACK_TOKEN`| `glpat-...` | 唯讀存取 fallback Token |
| `DATA_DIR` | `/data` | 容器內部 SQLite 資料夾（儲存 sessions 與 repo_access 白名單） |

---

## 6. 常見坑（Troubleshooting）

以下彙整實際維運中踩過的所有常見坑，每個問題皆附上**症狀、原因與正確解法**：

### 坑 1：`NOTE_BASE_URL` 填寫 `https://note.ia`
- **症狀**：同步腳本連線失敗，出現 DNS 解析錯誤（`NameResolutionError`）或 SSL 憑證驗證失敗（`SSLError`）。
- **原因**：docker-host 容器內部無法解析 `.ia` 內部網域名稱（DNS 位於 FortiGate），且容器預設不信任內部自簽 CA（mkcert）。
- **正確做法**：容器內的 `NOTE_BASE_URL` 務必填寫內網直連位址 `http://10.11.12.55:8790`。

### 坑 2：使用 `PORT` 作為環境變數名稱
- **症狀**：容器啟動後，外部無論如何 curl 該 port 都回傳 `502 Bad Gateway` 或連線被拒絕。
- **原因**：Uvicorn 會自動讀取名為 `PORT` 的環境變數作為其內部監聽埠，若設為 `PORT=8510`，Uvicorn 會改在容器內監聽 8510，導致 compose 的 `8510:8500` 映射失效。
- **正確做法**：環境變數名稱請命名為 `HOST_PORT`；容器內 Uvicorn 一律固定監聽 `8500`。

### 坑 3：Port `8500` 被佔用
- **症狀**：`docker compose up` 失敗，提示 `bind: address already in use`。
- **原因**：`8500` port 在 docker-host 上已被 `secrets.ia` 佔用。
- **正確做法**：新服務請挑選其他未被使用的 port（例如 `8511`, `8512` 等），POC 看板則使用 `8510`。

### 坑 4：Compose Volume 掛載單一檔案
- **症狀**：容器啟動時 crash，或提示目標路徑為目錄無法開啟。
- **原因**：若 host 端被掛載的檔案尚不存在，Docker 會自動在 host 端建立一個同名資料夾，導致程式讀取該檔案時拋出錯誤。
- **正確做法**：Compose volume 請一律掛載資料夾，如 `./data:/app/data`，不要直接掛載單一檔案。

### 坑 5：CI 跑了 `git reset` 但服務程式碼沒更新
- **症狀**：GitLab CI deploy 綠燈，但線上排程行為依然是舊版邏輯。
- **原因**：Python 同步服務是透過 Dockerfile 打包進 Image 的。單純在 host 上執行 `git reset --hard` 只更新了 host 上的檔案，若沒有執行 `docker compose up -d --build`，容器依然在跑舊的 Image。
- **正確做法**：CI deploy 需比對 `sync/` 目錄有無變更，若有變更必須觸發 `docker compose up -d --build` 重建容器。

### 坑 6：HTTPS 看板頁面無法直接 fetch HTTP 內網 IP
- **症狀**：瀏覽器 Console 噴出 `Mixed Content: The page at 'https://note.ia/...' was loaded over HTTPS, but requested an insecure resource 'http://10.11.12.55:8510/...'. This request has been blocked.`。
- **原因**：現代瀏覽器安全策略嚴格禁止 HTTPS 網頁請求 HTTP 協定資源，且無法由使用者手動略過。
- **正確做法**：在 NPM 的 note.ia proxy host 新增 Custom Location 反向代理，將 API 封裝為同源的 HTTPS 路徑（如 `/poc-sync`）。

### 坑 7：NPM patch locations 時誤用 `JSON.stringify`
- **症狀**：執行 patch 腳本後，NPM 重載失敗，Nginx 產生語法錯誤或設定檔損壞。
- **原因**：NPM 的 ORM model 要求 `locations` 欄位為原生 Javascript Object Array，若傳入 JSON stringified 字串，Nginx 設定生成器會異常。
- **正確做法**：直接傳入陣列物件 `{ locations: [{ path: "...", ... }] }`，且在修改前務必備份 `database.sqlite`。

### 坑 8：寫回前未驗證 JSON 合法性
- **症狀**：看板頁面開啟變成完全空白，瀏覽器 Console 顯示 `JSON.parse` 錯誤。
- **原因**：同步腳本組裝 JSON 字串時若有跳脫錯誤或截斷，未經檢查直接寫回 HTML，會直接破壞前端解析。
- **正確做法**：寫回前務必呼叫 `_assert_valid_json_block()` 進行 `json.loads()` 驗證，解析失敗立刻拋出例外中止寫入。

### 坑 9：未設計同步冪等性（Idempotency）
- **症狀**：每次同步都會重複新增相同的備註或紀錄，導致資料重複膨脹。
- **原因**：沒有使用唯一鍵值進行去重判斷。
- **正確做法**：每筆資料必須記錄唯一鍵（例如 Slack 訊息的 `slack_ts` 或外部系統的唯一 ID），每次寫入前先比對去重，確保連續執行兩次結果完全一致。

### 坑 10：覆蓋寫入時抹除未知欄位
- **症狀**：其他人在 JSON 中手動新增或擴充的自訂欄位，在排程跑完後全部消失。
- **原因**：腳本讀入時將資料轉換為嚴格的特定 Model，輸出時未定義的欄位被丟棄。
- **正確做法**：以原始字典（raw `dict`）維護資料結構，合併更新時只修改對應屬性，原樣保留所有未辨識的擴充欄位。

### 坑 11：目標 Repo 忘記設定為 `open` 存取模式
- **症狀**：同步腳本呼叫 note API 時收到 `403 Forbidden` 或 `401 Unauthorized`。
- **原因**：同步服務呼叫 API 時未帶使用者登入 session，若 repo 處於預設的 `login` 模式會被直接拒絕。
- **正確做法**：前往 `https://note.ia/admin`，將該 repo 的模式調整為 `open`。

### 坑 12：`GITLAB_OPEN_TOKEN` 權限不足
- **症狀**：note server 日誌出現 GitLab API 回傳 `403` 或 `404`，檔案無法寫回 commit。
- **原因**：伺服器端採用的 Token 權限不足（Role 低於 Developer），或建立 PAT 時未勾選 `api` scope。
- **正確做法**：重新產生具備 Developer（含）以上權限、且 Scope 包含 `api` 的 GitLab PAT 並設定至 note 的 `.env`。

---

## 7. 驗收清單

建置完成後，請依序核對以下清單以確認系統正常上線：

- [ ] **容器運行正常**：在 docker-host 執行 `docker compose ps`，容器狀態為 `Up (healthy/running)`。
- [ ] **狀態端點正常**：執行 `curl -f http://127.0.0.1:<HOST_PORT>/status` 能取回 HTTP 200 與最新狀態 JSON。
- [ ] **手動觸發有效**：發送 `POST http://127.0.0.1:<HOST_PORT>/sync`，能順利完成同步且回傳 `{"ok": true, ...}`。
- [ ] **GitLab 出現 Commit**：至 GitLab 專案歷史紀錄查看，能看到由 note 代表提交的檔案更新 commit。
- [ ] **note 看板頁面正常**：開啟 `https://note.ia/site/gitlab/<repo>?f=<board.html>` 能正常載入且資料正確呈現。
- [ ] **同步冪等性確認**：連續執行兩次同步，GitLab 上第二次不應產生多餘重複的歷史紀錄或重複資料。
- [ ] **HTTPS 即時同步按鈕（如有設定）**：在看板點擊「立即同步」按鈕，能透過同源代理順利觸發並更新畫面。

---

## 8. 延伸閱讀與參考檔案

- **參考實作原始碼**：GitLab `interagent-io/global-doc` 之 `客戶POC/sync/`
- **note 部署手冊**：[DEPLOY.md](../DEPLOY.md)（含 Repo 存取模式、Token 配置與架構說明）
- **NPM 反向代理設定**：`interagent-bible/deploy/note-nginx-proxy-manager.md`
