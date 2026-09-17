#!/usr/bin/env bash
# ==============================================================================
# 標準部署腳本（全專案同一套形狀）
#
# 由 .gitlab-ci.yml 的 deploy job 在部署目錄呼叫；也可人工在部署目錄直接執行。
# 呼叫端負責把程式碼更新到位（git fetch + git reset --hard），
# 本腳本只負責「前置防護 → 起容器 → 健康檢查」，失敗時 dump log 並 exit 1。
#
# 可用環境變數：
#   HEALTH_URL   健康檢查網址，未設則跳過檢查
#   HEALTH_TRIES 檢查次數（預設 24，每次間隔 5 秒 = 最長 2 分鐘）
#   NOTE_GITEA_DEPLOY 設為 1 時，檢查公司 CA 並驗證容器可經 HTTPS 連到 Gitea
#
# 鐵則 1：docker compose 一律不帶 -f（帶了 docker-compose.override.yml 會失效）
# 鐵則 2：不准 git clean（.env / data/ / override 都是未追蹤的正式資料）
# 鐵則 3：不准用 rsync 從 runner build dir 同步（會把 runner 的暫時性
#         .gitlab-runner.ext.conf 寫進部署目錄的 .git/config，之後 interagent
#         在該目錄跑任何 git 都會 Permission denied —— note 專案已踩過並修掉）
# ==============================================================================
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TRIES="${HEALTH_TRIES:-24}"

[[ -f docker-compose.yml ]] || {
  echo "[ERROR] 目前目錄沒有 docker-compose.yml，不是部署目錄：$PWD" >&2
  exit 1
}

# ------------------------------------------------------------------------------
# note 專屬防護：禁止 compose 把 host 的 dist 掛進容器
# 背景：若把 host 路徑掛到容器內 /app/client/dist 或 /app/server/dist，
#       CI 建好的新 image 會被 host 上的舊產物覆蓋
#       → pipeline 綠燈但畫面與新功能完全沒更新（最難查的那種假成功）。
# ------------------------------------------------------------------------------
for f in docker-compose*.yml docker-compose*.yaml; do
  [[ -f "$f" ]] || continue
  if grep -E ':/app/(client|server)/dist' "$f" | grep -vqE '^\s*#'; then
    echo "[ERROR] $f 把 host 的 dist 掛進容器，會讓新版被舊產物覆蓋" >&2
    echo "        修法：把該檔改名為 .disabled，或移除那兩行 dist 掛載後重跑" >&2
    exit 1
  fi
done

# ------------------------------------------------------------------------------
# BUILD_SHA：實測 compose 的 build arg 鏈（ARG → ENV → vite）傳遞不可靠，
# 改用實體檔案傳進 build context 讓 Vite 穩定讀到。client/.build-sha 已在
# .gitignore，不會被 git reset 覆蓋。
# ------------------------------------------------------------------------------
BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD)}"
echo "$BUILD_SHA" > client/.build-sha
echo "==> BUILD_SHA = $BUILD_SHA"

if [[ "${NOTE_GITEA_DEPLOY:-}" == "1" ]]; then
  internal_ca_path="${INTERNAL_CA_PATH:-}"
  if [[ -z "$internal_ca_path" ]]; then
    while IFS='=' read -r key value; do
      if [[ "$key" == "INTERNAL_CA_PATH" ]]; then
        internal_ca_path="$value"
      fi
    done < <(docker compose config --environment)
  fi
  internal_ca_path="${internal_ca_path:-/home/interagent/ca-web/rootCA.pem}"
  if [[ ! -r "$internal_ca_path" ]]; then
    echo "[ERROR] Gitea root CA 不存在或無法讀取：$internal_ca_path" >&2
    exit 1
  fi
  if ! openssl x509 -in "$internal_ca_path" -noout >/dev/null 2>&1; then
    echo "[ERROR] Gitea root CA 不是有效的 PEM certificate：$internal_ca_path" >&2
    exit 1
  fi
fi

probe_gitea() {
  [[ "${NOTE_GITEA_DEPLOY:-}" == "1" ]] || return 0

  echo "==> 驗證 Note 容器可經 GITEA_URL 連到 Gitea"
  docker compose exec -T note node -e '
    const url = new URL(process.env.GITEA_URL || "");
    if (url.protocol !== "https:") throw new Error("GITEA_URL 必須使用 HTTPS");
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/healthz`;
    fetch(url, { signal: AbortSignal.timeout(5000) })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok || body?.status !== "pass") {
          throw new Error(`Gitea health probe failed (HTTP ${res.status})`);
        }
        console.log(`Gitea HTTPS health probe passed (HTTP ${res.status})`);
      })
      .catch((err) => { console.error(err); process.exit(1); });
  '
}

echo "==> docker compose up -d --build"
BUILD_SHA="$BUILD_SHA" docker compose up -d --build

if [[ -z "$HEALTH_URL" ]]; then
  echo "==> 未設定 HEALTH_URL，跳過健康檢查"
  if ! probe_gitea; then
    echo "[ERROR] Note 容器無法經 GITEA_URL 連到 Gitea" >&2
    docker compose logs --tail 80
    exit 1
  fi
  docker compose ps
  exit 0
fi

echo "==> 健康檢查 $HEALTH_URL（最多 ${HEALTH_TRIES} 次，每次間隔 5 秒）"
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    if ! probe_gitea; then
      echo "[ERROR] Note 容器無法經 GITEA_URL 連到 Gitea" >&2
      docker compose logs --tail 80
      exit 1
    fi
    echo "==> 部署成功"
    docker compose ps
    docker image prune -f
    exit 0
  fi
  sleep 5
done

echo "[ERROR] 健康檢查失敗：$HEALTH_URL" >&2
docker compose ps
docker compose logs --tail 80
exit 1
