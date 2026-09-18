# Note 背景任務與同步盤點

> 盤點時間：2026-09-18。範圍：note server 本體（`note` 容器）與其外部的 POC 看板同步服務。
> 對象：維運與開發。任何「任務／頻率／觸發條件」以此文件為準。

---

## 0. 一句話結論

note 本體**沒有 cron**。真正的週期性工作只有兩個 in-process 計時器（write queue、collab snapshot），
其餘都是「請求時觸發」或「讀取時過期」。**POC 看板同步不在 note 內**，是獨立容器 `poc-sync`。

---

## 1. note 本體（container `note`，`docker-host:8790`）

容器 crontab 只有 Alpine 預設 `run-parts`（`/etc/periodic/*`），與業務無關。

### 1.1 Write queue worker（POC 看板／CRM 等互動頁寫入落地）

| 項目 | 內容 |
| --- | --- |
| 任務 | 把互動 HTML 頁（POC 看板、CRM 等）的寫入，合併成單一 commit 落地 |
| 發送到哪裡 | provider repo（Gitea / GitLab / GitHub）commit，走 `/api/file` 同一組 provider 寫入 |
| 頻率 | tick 每 **250ms**（`NOTE_QUEUE_TICK_MS`），每次最多處理 **5** 筆（`MAX_PER_TICK`） |
| 觸發條件 | job 的 `quiet_deadline`（靜默 **1500ms**，`NOTE_QUEUE_QUIET_MS`）或 `cap_deadline`（硬上限 **5000ms**，`NOTE_QUEUE_CAP_MS`）到期 |
| 啟動位置 | `server/src/index.ts:3018` `startWriteQueue()` |
| 實作 | `server/src/write-queue.ts:562` |
| 失敗處理 | 指數退避（2s 起、上限 30s），最多 **5** 次（`NOTE_QUEUE_MAX_ATTEMPTS`）；sha 衝突標 `conflict` 不覆蓋 |
| 停用 | `NOTE_QUEUE_DISABLED=1`（正式站未停用） |
| 重啟行為 | 開機把殘留 `running` 收回 `pending`（`recoverRunningJobs`，`write-queue.ts:556`） |

觸發端點（寫入排入）：

- `POST /api/enqueue-file/:provider/:project`（`index.ts:1736`）→ 回 `202 { jobId, status: "pending", quietMs }`
- `POST /api/enqueue-flush`（`index.ts:1808`）→ 頁面離開時用 `navigator.sendBeacon` 跳過安靜視窗立即落地
- `GET /api/enqueue-status`（`index.ts:1777`）→ 輪詢狀態

前端觸發點：`client/src/pages/Workspace.tsx:722` 互動頁 `saveFile`；
`sourceGroup = 檔案路徑`，預設 commit message `更新 <path>（via 互動頁）`（`Workspace.tsx:721`）。
無自訂 message 時，server 端預設 `docs: 更新 <paths>（互動頁）`（`write-queue.ts:179`）。

### 1.2 Collab 共筆 snapshot

| 項目 | 內容 |
| --- | --- |
| 任務 | 把 Yjs 共筆房間的內容寫回 repo |
| 發送到哪裡 | 同一 provider repo commit（`docs: update <filePath> via note 共筆`） |
| 頻率 | 閒置 **5 秒**（`SNAPSHOT_IDLE_MS`）或持續編輯時每 **30 秒**（`SNAPSHOT_MAX_INTERVAL_MS`） |
| 觸發條件 | `markDirty`（有編輯）→ idle/cap timer；最後一人離線再補一次 `snapshotIfEmpty` |
| 實作 | `server/src/collab.ts:119`（timer）、`:134`（snapshot）、`:323`（離線） |
| 手動立即 | `POST /api/collab/flush` → `flushRoom`（`collab.ts:184`） |
| 上限 | 內容 > 2MB 停止自動存檔（`COLLAB_MAX_BYTES`），避免垃圾 commit 倍增 |
| 啟用範圍 | `NOTE_COLLAB=1`，且 `NOTE_COLLAB_DOCS` 列出的文件才開房（正式站目前只有 `gitlab/interagent-io%2Fglobal-doc/test.md`） |

### 1.3 其他（非週期性）

| 任務 | 觸發條件 | 位置 |
| --- | --- | --- |
| Raw grant 過期清理 | 建立新 grant 時順手刪過期列（TTL 90 天） | `db.ts:382`（`createRawGrant` 內呼叫） |
| `repoMetaCache` 過期 | 讀取時檢查，TTL 30 秒，key 含 token；超過 500 筆整清 | `index.ts:764` |
| `siteRepoCache` 過期 | 讀取時檢查，TTL 60 秒 | `index.ts:1406` |
| OAuth token 續期 | 請求時距到期 < 120 秒且有 refresh token | `index.ts:193` |
| `purgeStaleCollabState` | collab 相關流程 | `collab.ts` 呼叫 `collab-store.ts` |

### 1.4 沒有做的事

- 沒有 cron 式的「定時 pull/sync provider repo」。
- 沒有清理 `write_jobs`、`shares`、`short_links` 的排程；**`write_jobs` 永久保留終態 job（含完整檔案內容）**。
- 沒有 queue 深度／卡死告警，只有 `console.log` 進 docker log。

---

## 2. POC 看板同步（container `poc-sync`，獨立於 note）

| 項目 | 內容 |
| --- | --- |
| 位置 | `docker-host` 容器 `poc-sync`（image `sync-poc-sync`），host port **8510** |
| 原始碼 | GitLab `interagent-io/global-doc` 的 `客戶POC/sync/` |
| 技術 | Python 3.11 + FastAPI + Uvicorn，背景執行緒輪詢 |
| 輪詢 | `threading.Thread` + `while True` + `time.sleep(60)` 每分鐘檢查時間戳 |
| 同步頻率 | **`SYNC_INTERVAL_S=600`（10 分鐘）**（正式站實測 log 每 10 分鐘一次） |
| 定時提醒 | 台灣**工作日 11:00 與 14:00** 發 Slack 待辦提醒；國定假日用 `TW_HOLIDAY_ICS_URL`，抓不到則只排除週六日 |
| 資料來源 | Slack API、Google Calendar iCal（正式站有設 `GCAL_ICS_URL`） |
| 寫到哪 | 打 note API：`GET/PUT {NOTE_BASE_URL}/api/file/gitlab/...`（正式站 `NOTE_BASE_URL=http://10.11.12.55:8790`） |
| 憑證 | 同步容器**不持有 git 憑證**；由 note 用伺服器端 `GITLAB_OPEN_TOKEN` 代 commit |
| 手動端點 | `POST /sync`（立即同步）、`GET /status`、`POST /post`、`GET /members` |
| 狀態存放 | `STATE_DIR=/app/data`（`state.json`：`last_ts`、`bookings`、`crm_sync_schedule`、`reminder_last_run`） |

### 2.1 一個 `background_scheduler` 執行緒跑三件事

`main.py:1169` 每 **60 秒**醒一次，依序做：

1. **一般同步**（`do_sync_task` → `run_sync`）：距上次滿 `SYNC_INTERVAL_S=600` 才跑，用 `sync_lock` 防重疊；鎖被佔用時記 `Scheduled sync skipped` 並順延。
2. **定時提醒**（`run_due_reminders`）：每次都檢查，靠 `reminder_last_run` 的**當天日期**防重複。
3. **CRM 排程同步**（`check_and_run_scheduled_crm_sync`）：每次都檢查，比對 `HH:MM` 字串與 `last_occurrence` 防重複。

### 2.2 什麼訊息會觸發（一般同步 `run_sync`，每 10 分鐘）

資料來源是 Slack 兩個頻道，不是「收到訊息即時推」——是**輪詢**，所以最多延遲 10 分鐘。

| 頻道 | 用途 | 處理 |
| --- | --- | --- |
| `C047PD51DA5`（`#poc`） | 業務貼的 POC／客戶進度 | `fetch_slack_messages` |
| `C0ALDTJ4J2U`（`#新客戶預約demo`） | 預約表單機器訊息 | `process_booking_messages` |

`#poc` 訊息的過濾與比對規則：

1. **雜訊先剔除**（`is_noise`）：純 emoji、機器人／bot、`TRIVIAL_WORDS`（`好`、`收到`、`ok`、`謝謝`、`👍` 等）、正規化後為空。
2. **前綴過濾**（`passes_prefix_filter`）：清單取自 `customers.md` 的 `設定.Slack前綴`，**每輪重讀，改看板設定下一輪就生效**。正式站目前是 `['!!', '！！', '•']`；空清單＝不過濾。
3. **比對客戶**（`match_customer`）：用 `build_alias_map(customers)` 產生的別名表；比不到時**繼承討論串主訊息**的客戶（`_parent_text`）。
4. 比不到 → 寫進 `客戶POC/待確認.md`（`append_unmatched`，commit `sync: 新增 N 則待確認訊息`）。

寫回動作：

- 有新備註／新預約客戶／狀態推進／行事曆更新時，**一次送 `customers.md` + `customers.html` 兩檔到同 `sourceGroup = "客戶POC/board"`**（`enqueue_note_files` → `POST /api/enqueue-file/gitlab/interagent-io%2Fglobal-doc`），由 note 的 queue worker 保證同一個 commit。
- commit message 由 `commit_parts` 組：`sync: 從 #poc 補 N 則更新、新增 N 筆新預約客戶、推進 N 筆尚未回覆、行事曆更新 N 筆`。
- note 若無 queue 端點（404/405/501）會退回同步 `PUT /api/file`（各檔一個 commit）。

### 2.3 定時提醒（3 種，台灣工作日）

`reminders.py`／`main.py:650`。時間窗為 **2 小時**（`REMINDER_WINDOW_HOURS`，容器在時間點前後重啟仍補得回來），防重複靠 `reminder_last_run` 的當天日期。

| 類型 | 觸發時間（台北） | 發到 | 內容 |
| --- | --- | --- | --- |
| `upcoming` | **09:30** | `#poc`（`C047PD51DA5`） | 今天／下一工作天的 Demo 預約 |
| `todo` | **09:45** | `#poc`（`C047PD51DA5`） | 待辦到期 |
| `stale` | **14:00** | 預約頻道（`C0ALDTJ4J2U`），**回在該筆預約 thread** | 逾期未進度，tag `<@UR5CAMHMG>` |

- 非工作日不發：先看 `TW_HOLIDAY_ICS_URL` 的台灣國定假日 iCal；抓不到就**降級只排除週六日**。
- 可用 `REMINDERS_ENABLED=false` 停用（未設定＝啟用）。

### 2.4 CRM 排程同步（`check_and_run_scheduled_crm_sync`）

| 項目 | 內容 |
| --- | --- |
| 頻率 | **每日 09:00 與 17:00**（台北；`crm_sync_schedule.times`，正式站實測 `last_occurrence = 2026-09-17 17:00`） |
| 比對方式 | 比對 `HH:MM` 字串＋`last_occurrence`，每分鐘檢查一次故時間點必然命中 |
| 動作 | `reconcile_poc_to_crm`：把 `客戶POC` 的資料對帳進 `內部/CRM/crm.md` 與 `crm.html` 的 `pocMirror`／`pocManualQueue` |
| 目標檔 | `CRM_NOTE_PATH = 內部/CRM/crm.md`、`CRM_HTML_PATH = 內部/CRM/crm.html` |
| 可設定 | 可由 `POST /crm/sync-settings` 改時間／停用，設定存在 `state.json` |

> `docs/排程同步看板-how-to.md` 是這套架構的完整建置手冊（670 行），要新增同類同步服務看那份。

---

## 3. 全系統定時任務總表（一眼版）

| 時間／頻率 | 任務 | 發到 | 觸發條件 |
| --- | --- | --- | --- |
| 每 250ms | note write queue tick | 無（有到期 job 才寫 repo） | `quiet_deadline` 1500ms 或 `cap_deadline` 5000ms 到期 |
| 編輯後 5s / 每 30s | note collab snapshot | repo commit | 房間 dirty；最後一人離線補一次 |
| 每 60s | poc-sync `background_scheduler` 醒來 | — | 主迴圈 |
| 每 600s | poc-sync 一般同步（Slack → 看板） | note API → GitLab `global-doc` | 距上次滿 600s 且未被鎖佔用 |
| 09:30（工作日） | poc-sync `upcoming` 提醒 | Slack `#poc` | 2 小時窗 + 當天未發 |
| 09:45（工作日） | poc-sync `todo` 提醒 | Slack `#poc` | 2 小時窗 + 當天未發 |
| 14:00（工作日） | poc-sync `stale` 提醒 | Slack 預約頻道 thread | 2 小時窗 + 當天未發 |
| 09:00、17:00 | poc-sync CRM 對帳同步 | note API → `內部/CRM/crm.md`、`crm.html` | `HH:MM` 命中＋`last_occurrence` 未跑 |

---

## 4. 已知缺口（尚未處理）

1. `write_jobs` 無保留期限，終態 job 與其 `files_json` 永久成長。
2. queue worker 若 timer 意外停止，無告警、無自我重啟。
3. 全系統只有 `console.log`，無 metric／告警／queue 深度可視化。
