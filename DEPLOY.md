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
