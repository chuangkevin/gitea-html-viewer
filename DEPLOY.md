# note — 部署到 docker-host

單一容器（Express 同時服務 API 與前端 build）。docker-host 上**本地 build、本地起**，
不繞 Docker Hub。對外只綁一個 port（預設 `8790`），domain 由 docker-host 的
Nginx Proxy Manager（NPM）反代 → 見 `interagent-bible/deploy/note-nginx-proxy-manager.md`。

## 0. 前置：把 code 放上 GitLab（interagent-io）

目前 repo 的 origin 還指向 GitHub。改指到公司 GitLab 後推上去：

```bash
cd note
# 在 gitlab.com/interagent-io 先手動建一個空專案：note
git remote set-url origin https://gitlab.com/interagent-io/note.git
git add -A && git commit -m "feat: GitLab 支援 + docker-host 部署設定，改名 note"
git push -u origin main
```

> 若要保留 GitHub 當鏡像：改用 `git remote add gitlab …` 而非 set-url。

## 1. 取得 code（在 docker-host 上）

```bash
git clone https://gitlab.com/interagent-io/note.git
cd note
```

## 2. 設定 `.env`

```bash
cp .env.example .env
```

至少要填 **GitLab OAuth**（否則只能瀏覽 public、不能登入編輯）：

1. 到 `https://gitlab.com/-/profile/applications` 建一個 Application
   - **Scopes** 勾 `api`
   - **Redirect URI** 填 `<BASE_URL>/api/auth/callback`
     （先直連測試就是 `http://<docker-host-ip>:8790/api/auth/callback`；
      之後上 NPM domain 要**改成正式網址並回來更新這裡與 `.env` 的 BASE_URL**）
2. 把拿到的 Application ID / Secret 填進 `.env`：
   ```
   BASE_URL=http://<docker-host-ip>:8790      # 上 domain 後改成 https://note.ia
   GITLAB_CLIENT_ID=...
   GITLAB_CLIENT_SECRET=...
   ```

> GitHub 也想開就一併填 `GITHUB_CLIENT_ID/SECRET`；不填就只顯示 GitLab 登入。
> `SECRET` 不填會自動產生存在 `data/.secret`（換機器要保留 `data/` 才能沿用既有 session/分享）。

> **💡 OAuth Callback 失敗排查**：
> 若 `docker logs note` 出現 `authorization grant is invalid ... does not match the redirection URI` 錯誤，代表 GitLab OAuth Application 的 Redirect URI 與目前 `.env` 的 `BASE_URL` 不一致。例如 `BASE_URL` 改成 `https://note.ia` 之後，必須回 GitLab 應用設定（`https://gitlab.com/-/profile/applications`）將 Redirect URI 一併修改為 `https://note.ia/api/auth/callback`。

### 團隊模式：多 token、一人一組（選配）

不想每個人都去跑 OAuth，但又要 commit 記在正確的人頭上時用這個：
每位成員一組自己的 GitLab token，配上他的名字 + email。

#### 1. Token 來源（二選一）

- **作法 A（最推薦 / 全方案通用）：個人 Personal Access Token**
  每位成員各自到 GitLab 產一組 Personal Access Token
  （`https://gitlab.com/-/user_settings/personal_access_tokens`，Scope 勾 `api`；要能存檔就必須有寫入權限）。

  > **💡 共用一把 PAT 也可以**：若部分成員沒有 GitLab 帳號或不想各自設定，也可以由一位具有文件 repo Developer（含）以上權限的成員（例如 Kevin），或另開一個專用的「文書機器人」GitLab 帳號，產一把 Scope 勾 `api` 的 PAT，填給 `identities.json` 上的多位成員共用；commit author 仍會依 `identities.json` 的 `name` / `email` 分別記名。缺點同樣是共用寫入權限、撤銷則全體同時失效。

- **作法 B（進階 / 比較乾淨）：使用 Project Access Token**
  ⚠️ **gitlab.com 的 Free 方案沒有這個功能（需 Premium/Ultimate）；如果建不出來就改用作法 A。**（自架 GitLab 才是 Free 方案就能用）

  若使用付費方案或自架 GitLab，可以直接使用文件專案（`interagent-io/global-doc`）的 Project Access Token：
  1. 前往文件 repo `interagent-io/global-doc` → **Settings** → **Access Tokens** 產生一組 Project Access Token。
  2. **Role** 選 `Developer`（含）以上，**Scopes** 必須勾選 `api`（說明：`note` 是透過 GitLab REST API v4 進行寫檔與 commit，而非傳統 Git over HTTP，因此 `write_repository` 權限不足，必須勾選 `api`）。
  3. **共用機制**：同一把 Project Access Token 可以設定給 `identities.json` 中的多位成員。因為後端（`server/src/gitlab.ts` 的 `writeFile`）寫檔時會帶入 `identities.json` 設定的 `name` 與 `email` 作為 `author_name` / `author_email`，即使全員共用同一把 token，commit 依然會精確掛在各自的人名與 email 名下。
  4. **缺點與風險**：共用 token 代表共用寫入權限，若該 token 被撤銷則全體共用成員會同時失效；且前端選取名字僅為識別而非身分驗證，內網中任何人皆可切換選取任意名字發起 commit（冒名風險）。

#### 2. 設定 `identities.json`（docker-host 上的實際位置與寫入方式）

- **檔案位置**：容器內 `/data/identities.json`，在 docker-host 上對應至 `/home/interagent/note/data/identities.json`。因為 `data/` 目錄屬於 root 擁有，一般使用者無法直接編輯該檔案。
- **使用 Helper Script 寫入**：
  docker-host 上已備有輔助腳本 `/home/interagent/note/set-note-token.sh`：
  - 執行 `./set-note-token.sh` 後會進入互動式輸入，貼上 Token（輸入時不回顯、不會寫入 shell history），腳本會自動建立/更新三位成員的設定檔。
  - 執行 `./set-note-token.sh --show` 可以查看目前設定的成員名單與狀態（Token 內容會自動打碼遮蔽）。
- **手動建立範例**（若以 root 或 sudo 權限編輯）：
  ```json
  [
    { "name": "王小明", "email": "ming@interagent.io", "token": "glpat-xxxxxxxxxxxx" },
    { "name": "李小華", "email": "hua@interagent.io",  "token": "glpat-yyyyyyyyyyyy" },
    { "name": "Kevin",  "email": "kevin@interagent.io", "token": "glpat-zzzzzzzzzzzz" }
  ]
  ```
  `provider` 可省略，預設 `gitlab`（要用 GitHub token 就加 `"provider": "github"`）。
- **自動重載**：存檔後 server 會依檔案修改時間（mtime）自動偵測並重新載入，**不用 rebuild 也不用重啟容器**。
  若不想使用檔案，也可以改設環境變數 `NOTE_IDENTITIES`（JSON 陣列字串），但每次修改需重啟容器。兩者皆未設定即表示團隊模式未啟用。

#### 3. 怎麼用

開任一 repo，右上角出現「👤 你是誰？」下拉選單，選自己的名字就能編輯與存檔；
commit 的 author 會是該成員的名字 + email（committer 則是 token 所屬的 GitLab 帳號，
所以 GitLab 上會顯示成「A 代 B 提交」）。沒選身分維持唯讀，隨時可以重選。

#### 4. ⚠️ 安全須知

- **選名字不是身分驗證**。沒有密碼、沒有任何檢查，能開到這個網站的人都可以選任何一個
  名字、用那個人的 token 寫 repo，也就是可以冒名 commit。這個模式的假設是
  「站台只在內網、進得來的人都是自己人」。要真正的身分驗證請走個人 OAuth 登入
  （兩種模式並存，個人登入優先）。
- **token 有寫入權限，等於 repo 的鑰匙**。`identities.json` 要保管好（`chmod 600`、
  只放在 docker-host 上、不要 commit 進 repo、不要貼到聊天室）。
  有人離職或 token 外流，就從清單移掉那筆並到 GitLab revoke 該 token。
- token 只留在 server：不會寫進 log、不會回傳給前端、不會進任何 API 回應；
  瀏覽器 cookie 只存「第幾位成員 + 名字」，且是 httpOnly + SameSite=Lax。
- 分享連結（公開分享）仍然只開給個人 OAuth 登入者，團隊身分沒有這個功能。

### repo 存取模式（admin 白名單）

管理員可將特定的 repository 設定為三種存取模式之一：
1. **免登入公開可編 (`open`)**：任何人開啟該 repo 網頁不必登入即可直接編輯並寫回 commit。
2. **要登入才能編 (`login`)**：預設行為。未登入者為唯讀模式，需登入個人 OAuth 或選取團隊身分方能編輯。
3. **只有 admin 能編 (`admin`)**：僅有管理員身分的使用者可以寫入，其餘使用者即使登入也為唯讀。

#### 1. 管理員登入與 `/admin` 管理頁
- **設定 ADMIN_KEY**：在 `.env` 中設定 `ADMIN_KEY=your_secret_admin_password` 後重啟容器。
- **存取管理頁**：前往 `/admin` 網址，輸入 `ADMIN_KEY` 密碼即可進入控制台新增或切換 repo 的存取模式。
- **OAuth 管理員白名單（選配）**：亦可在 `.env` 中設定 `ADMIN_LOGINS=username1,username2`，指定的使用者透過個人 OAuth 登入後將自動具備管理員權限。

#### 2. 設定免登入共用 Token（`GITHUB_OPEN_TOKEN` / `GITLAB_OPEN_TOKEN`）
- 若有 repo 被標記為「免登入公開可編 (`open`)」，必須在 `.env` 中設定對應 provider 的共用寫入 Token：
  - **GitLab**：填寫 `GITLAB_OPEN_TOKEN`。需為 GitLab Personal Access Token（PAT），**Scope 勾選 `api`**，且該 Token 所屬帳號需對目標 repo 具備 **Developer**（含）以上寫入權限。
    - *注意*：gitlab.com 的 Free 方案無法對專案建立 Project Access Token（僅 Premium/Ultimate 或自架支援），請一律使用 Personal Access Token。
  - **GitHub**：填寫 `GITHUB_OPEN_TOKEN`。需具備 repository 寫入權限（Fine-grained PAT 勾選 Contents read/write，或 Classic PAT 勾選 repo）。
- 可設定 `NOTE_OPEN_AUTHOR_NAME`（預設 `note 訪客`）與 `NOTE_OPEN_AUTHOR_EMAIL`（預設 `note@interagent.io`）作為免登入訪客 commit 時的預設作者；訪客亦可在網頁頂端署名欄填寫自己的稱呼。

#### 3. ⚠️ 安全與風險提醒
- **免登入公開可編 = 內網／能連到本站的任何人皆可編輯與提交 commit**。請僅對內部 trusted 專案開啟此模式。
- 共用 Token (`GITLAB_OPEN_TOKEN` / `GITHUB_OPEN_TOKEN`) 具備 repo 的權限，請妥善保管，**絕不可洩漏、寫入 log 或提交至 repository**。

### 首頁預設落地（選配）

`DEFAULT_REPO` 設了，開首頁「/」就直接導到該 repo 的 `DEFAULT_FILE`；
compose 預設值是 `gitlab/interagent-io%2Fglobal-doc` + `README.md`（預設文件專案為 `interagent-io/global-doc`）。
格式是 `<provider>/<URL-encode 過的 projectPath>`（GitLab 巢狀群組的 `/` 要寫成 `%2F`）。
想回原本首頁：`.env` 填 `DEFAULT_REPO=`（空值）關掉，或直接開 `/?home=1`。

## 3. 起服務

```bash
docker compose up -d --build
docker compose logs -f note        # 看到 "note-bridge server on :3210" 即成功
```

健康檢查：

```bash
curl -s http://localhost:8790/healthz     # {"ok":true,"github":false,"gitlab":true}
```

## 4. 綁 domain（NPM）

見 `interagent-bible/deploy/note-nginx-proxy-manager.md`。
綁好後記得回來把 `.env` 的 `BASE_URL` 改成正式網址（如 `https://note.ia`）、GitLab OAuth 的 Redirect URI 同步更新（如 `https://note.ia/api/auth/callback`），
再 `docker compose up -d` 讓新 BASE_URL 生效。

## Port 備註

- host `8790` → container `3210`。挑 8790 是因為 docker-host 現有服務（3210/5432/5678/6380/8001/8080/8300/8400 等）沒佔用它。
- 上機前確認仍是空的：`ss -ltn | grep 8790`（沒輸出＝可用）。要改就改 `docker-compose.yml` 的 `"8790:3210"` 左邊。

## CI/CD 自動部署

### 1. 架構圖

```
[ Developer ] -- push main --> [ GitLab Repo ]
                                     |
                                     v
                       +---------------------------+
                       |   Stage: check            |
                       | (gitlab.com shared runner)|
                       | - check-client (build/ts) |
                       | - check-server (build/ts) |
                       +---------------------------+
                                     | (Pass)
                                     v
                       +---------------------------+
                       |   Stage: deploy           |
                       | (docker-host runner)      |
                       | - git fetch & reset       |
                       | - docker compose up -d    |
                       | - Health Check (curl)     |
                       | - docker image prune      |
                       +---------------------------+
```

### 2. 首次設定（三步驟）

1. **GitLab 專案建 Project Runner 拿 Token**：
   - 到 GitLab 專案 -> **Settings** -> **CI/CD** -> **Runners**。
   - 點擊 **New project runner**，**Tags** 欄填寫 `dockerhost`（tag 在 GitLab 網頁建立 runner 時填）。
   - 建立後複製 project runner token（格式為 `glrt-xxxxxxxx`）。

2. **docker-host 跑安裝腳本**：
   - 登入 `docker-host`（`10.11.12.55`）切換至專案目錄。
   - 帶入 Token 執行安裝與註冊腳本：
     ```bash
     REG_TOKEN="glrt-xxxxxxxxxxxx" sudo -E ./deploy/install-gitlab-runner.sh
     ```

3. **push 驗證 Pipeline**：
   - 提交變更並 push 至 `main` 分支。
   - 至 GitLab **Build** -> **Pipelines** 觀察 `check` 與 `deploy` 階段是否皆順利通過。

### 3. 日常維護

- **日常部署**：`push main 即部署`。包含分支 Merge Request 併入 `main` 或直接 push `main` 分支均會自動觸發完整 CI/CD 流程。
- **故障排查**：
  - **Runner Offline**：至 docker-host 執行 `gitlab-runner status` 或 `sudo gitlab-runner verify` 檢視服務狀態。
  - **Deploy Fail**：先在 GitLab Pipeline 頁面檢視 Job Log；若為健康檢查或容器啟動失敗，登入 docker-host 執行 `docker logs note` 查看容器日誌。
  - **deploy job 出現 cd: Permission denied**：若 deploy job 第一行指令出現 `bash: cd: /home/interagent/note: Permission denied`，代表 gitlab-runner 使用者對部署目錄或其上層目錄缺乏通行/存取權限。重跑安裝腳本 `sudo -E ./deploy/install-gitlab-runner.sh` 即可自動調整權限修復。

### 4. 新專案要接上這台 runner

該專案建 project runner（tag 填 `dockerhost`）→ 在 docker-host 重跑本腳本（會跳過已安裝步驟）→ 該專案 `.gitlab-ci.yml` 的 deploy job 掛 `tags: [dockerhost]`。

## 手動部署 / 備援更新

若 CI/CD 或 Runner 異常時，可手動登入 docker-host 執行以下指令作為備援：

```bash
git pull && docker compose up -d --build
```

## 資料

- `./data`（bind mount）：SQLite（sessions + 分享 token）與 `.secret`。備份就備份這個目錄。
- 文件本體不在這裡——都在使用者各自的 GitLab/GitHub repo（預設文件專案為 `interagent-io/global-doc`）。

