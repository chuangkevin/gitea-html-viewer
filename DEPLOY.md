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
   BASE_URL=http://<docker-host-ip>:8790      # 上 domain 後改成 https://note.<你的內網域>
   GITLAB_CLIENT_ID=...
   GITLAB_CLIENT_SECRET=...
   ```

> GitHub 也想開就一併填 `GITHUB_CLIENT_ID/SECRET`；不填就只顯示 GitLab 登入。
> `SECRET` 不填會自動產生存在 `data/.secret`（換機器要保留 `data/` 才能沿用既有 session/分享）。

### 團隊模式：多 token、一人一組（選配）

不想每個人都去跑 OAuth，但又要 commit 記在正確的人頭上時用這個：
每位成員一組自己的 GitLab token，配上他的名字 + email。

**啟用步驟**

1. 每位成員各自到 GitLab 產一組 Personal Access Token
   （`https://gitlab.com/-/user_settings/personal_access_tokens`，scope 勾 `api`；
   要能存檔就必須有寫入權限）。
2. 在 docker-host 上建 `/home/interagent/note/data/identities.json`
   （`data/` 已經掛進容器，也已在 `.gitignore` 裡，不會被 commit）：

   ```json
   [
     { "name": "王小明", "email": "ming@interagent.io", "token": "glpat-xxxxxxxxxxxx" },
     { "name": "李小華", "email": "hua@interagent.io",  "token": "glpat-yyyyyyyyyyyy" },
     { "name": "Kevin",  "email": "kevin@interagent.io", "token": "glpat-zzzzzzzzzzzz" }
   ]
   ```

   `provider` 可省略，預設 `gitlab`（要用 GitHub token 就加 `"provider": "github"`）。
3. `chmod 600 data/identities.json`（裡面是 token）。
4. 存檔即生效——server 看 mtime 自動重載，**不用 rebuild 也不用重啟**。
   不想用檔案的話，也可以改設環境變數 `NOTE_IDENTITIES`（同樣的 JSON 陣列），
   但改一次要重啟容器。兩者都沒有 = 團隊模式未啟用，行為跟原本完全一樣。

**怎麼用**：開任一 repo，右上角出現「👤 你是誰？」下拉，選自己的名字就能編輯、存檔；
commit 的 author 會是該成員的名字 + email（committer 則是 token 所屬的 GitLab 帳號，
所以 GitLab 上會顯示成「A 代 B 提交」）。沒選身分維持唯讀，隨時可以重選。

**⚠️ 安全須知**

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

### 首頁預設落地（選配）

`DEFAULT_REPO` 設了，開首頁「/」就直接導到該 repo 的 `DEFAULT_FILE`；
compose 預設值是 `gitlab/interagent-io%2Finteragent-bible` + `README.md`。
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
綁好後記得回來把 `.env` 的 `BASE_URL` 改成正式網址、GitLab OAuth 的 Redirect URI 同步更新，
再 `docker compose up -d` 讓新 BASE_URL 生效。

## Port 備註

- host `8790` → container `3210`。挑 8790 是因為 docker-host 現有服務（3210/5432/5678/6380/8001/8080/8300/8400 等）沒佔用它。
- 上機前確認仍是空的：`ss -ltn | grep 8790`（沒輸出＝可用）。要改就改 `docker-compose.yml` 的 `"8790:3210"` 左邊。

## 更新

```bash
git pull && docker compose up -d --build
```

## 資料

- `./data`（bind mount）：SQLite（sessions + 分享 token）與 `.secret`。備份就備份這個目錄。
- 文件本體不在這裡——都在使用者各自的 GitLab/GitHub repo。
