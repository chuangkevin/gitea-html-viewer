#!/usr/bin/env bash
# ==============================================================================
# GitLab Runner 安裝與註冊腳本 (docker-host 專用)
# ==============================================================================
# 前置步驟 (取得 GitLab Project Runner Token)：
# 1. 在 GitLab 專案 Settings → CI/CD → Runners → New project runner，Tags 欄填 dockerhost，建立後複製 glrt- 開頭 token
# 2. 在 docker-host 執行此腳本 (需 root / sudo 權限)：
#    REG_TOKEN="glrt-xxxxxxxxxxxx" sudo -E ./deploy/install-gitlab-runner.sh
# ==============================================================================

set -euo pipefail

REG_TOKEN="${REG_TOKEN:-}"
DEPLOY_DIR="${DEPLOY_DIR:-/home/interagent/note}"

echo "=== 1. 檢查並安裝 GitLab Runner ==="
if command -v gitlab-runner &> /dev/null; then
  echo "GitLab Runner 已安裝，跳過 apt 安裝步驟。"
else
  echo "正在新增官方 Apt Repo 並安裝 GitLab Runner..."
  curl -L "https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh" | sudo bash
  sudo apt-get install -y gitlab-runner
  echo "GitLab Runner 安裝完成。"
fi

echo "=== 2. 將 gitlab-runner 使用者加入 docker 群組 ==="
if id -nG gitlab-runner 2>/dev/null | grep -qw docker; then
  echo "gitlab-runner 已在 docker 群組中。"
else
  sudo usermod -aG docker gitlab-runner
  echo "已將 gitlab-runner 使用者加入 docker 群組。"
fi

echo "=== 3. 註冊 GitLab Runner ==="
# 注意：tag 在 GitLab 網頁建立 runner 時填（本專案用 dockerhost），
# 新版 token 流程不可在 CLI 指定 tag 等保留參數，否則 register 會 FATAL。
if command -v gitlab-runner &>/dev/null && ( sudo gitlab-runner list 2>&1 | grep -q "docker-host-note" || ( [ -f /etc/gitlab-runner/config.toml ] && grep -q 'name = "docker-host-note"' /etc/gitlab-runner/config.toml ) ); then
  echo "Runner 'docker-host-note' 已存在，跳過註冊步驟。"
else
  if [ -z "$REG_TOKEN" ]; then
    echo "錯誤: 未提供 REG_TOKEN 環境變數。"
    echo "使用範例: REG_TOKEN=\"glrt-your-token\" sudo -E $0"
    exit 1
  fi

  sudo gitlab-runner register \
    --non-interactive \
    --url "https://gitlab.com" \
    --token "$REG_TOKEN" \
    --executor "shell" \
    --description "docker-host-note"
  echo "GitLab Runner 註冊完成。"
fi
# 說明：tag 在 GitLab 網頁建立 runner 時填（本專案用 dockerhost），新版 token 流程不可在 CLI 指定，否則 register 會 FATAL。

echo "=== 4. 設定部署目錄權限 ==="
# 1. 取得上層目錄並設定通行權 (+x)，確保 gitlab-runner 能穿越家目錄進入部署目錄
#    特別說明：chmod o+x 僅提供目錄通行權 (execute)，不會允許其他使用者檢視或列出家目錄內容 (無 read 權限)，符合最小授權原則
PARENT_DIR="$(dirname "$DEPLOY_DIR")"
echo "設定上層目錄 ($PARENT_DIR) 通行權 (o+x)..."
sudo chmod o+x "$PARENT_DIR"

# 2. 取得部署目錄擁有者的群組，並將 gitlab-runner 使用者加入該群組
DEPLOY_GROUP="$(stat -c '%G' "$DEPLOY_DIR")"
echo "將 gitlab-runner 加入部署目錄群組 ($DEPLOY_GROUP)..."
sudo usermod -aG "$DEPLOY_GROUP" gitlab-runner

# 3. 對部署目錄設定遞迴群組讀寫與執行權限 (g+rwX)
echo "設定部署目錄 ($DEPLOY_DIR) 遞迴群組權限 (g+rwX)..."
sudo chmod -R g+rwX "$DEPLOY_DIR"

# 4. 重啟 gitlab-runner 服務以使新增的群組權限生效
echo "重啟 gitlab-runner 服務..."
sudo systemctl restart gitlab-runner

echo "=== 5. 驗證指令提示 ==="
echo "安裝與註冊已完成！請執行以下指令驗證服務與 Docker 權限："
echo "  - 檢查 Runner 註冊狀態: gitlab-runner verify"
echo "  - 測試 gitlab-runner 的 Docker 權限: sudo -u gitlab-runner docker ps"
