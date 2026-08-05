#!/usr/bin/env bash
# ==============================================================================
# GitLab Runner 安裝與註冊腳本 (docker-host 專用)
# ==============================================================================
# 前置步驟 (取得 GitLab Project Runner Token)：
# 1. 前往 GitLab 專案 -> Settings -> CI/CD -> Runners
# 2. 點擊 "New project runner"
# 3. Tags 填寫: dockerhost
# 4. 點擊 "Create runner" 後複製取得之 project runner token (格式如 glrt-xxxxxxxx)
# 5. 在 docker-host 執行此腳本 (需 root / sudo 權限)：
#    REG_TOKEN="glrt-xxxxxxxxxxxx" sudo -E ./deploy/install-gitlab-runner.sh
# ==============================================================================

set -euo pipefail

REG_TOKEN="${REG_TOKEN:-}"

if [ -z "$REG_TOKEN" ]; then
  echo "錯誤: 未提供 REG_TOKEN 環境變數。"
  echo "使用範例: REG_TOKEN=\"glrt-your-token\" sudo -E $0"
  exit 1
fi

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
sudo gitlab-runner register \
  --non-interactive \
  --url "https://gitlab.com" \
  --token "$REG_TOKEN" \
  --executor "shell" \
  --description "docker-host-note" \
  --tag-list "dockerhost"

echo "=== 4. 設定目錄權限說明 ==="
# Shell Executor 執行時需要對部署目錄 /home/interagent/note 有讀寫權限。
# 以下提供兩種常用的權限設定作法，請依據現場權限政策擇一執行：
#
# 作法 A (使用 POSIX ACL，推薦，不改變原目錄擁有者與群組)：
#   sudo setfacl -R -m u:gitlab-runner:rwx /home/interagent/note
#   sudo setfacl -d -m u:gitlab-runner:rwx /home/interagent/note
#
# 作法 B (變更目錄權限或擁有者)：
#   sudo chown -R interagent:docker /home/interagent/note
#   sudo chmod -R 775 /home/interagent/note
#   或直接變更擁有者：
#   sudo chown -R gitlab-runner:gitlab-runner /home/interagent/note

if command -v setfacl &> /dev/null; then
  echo "偵測到 setfacl，嘗試自動套用 ACL 權限..."
  sudo setfacl -R -m u:gitlab-runner:rwx /home/interagent/note || true
  sudo setfacl -d -m u:gitlab-runner:rwx /home/interagent/note || true
  echo "已完成 ACL 權限設定。"
else
  echo "未偵測到 setfacl 指令，請參考上述註解手動執行 chown / chmod 指令。"
fi

echo "=== 5. 驗證指令提示 ==="
echo "安裝與註冊已完成！請執行以下指令驗證服務與 Docker 權限："
echo "  - 檢查 Runner 註冊狀態: gitlab-runner verify"
echo "  - 測試 gitlab-runner 的 Docker 權限: sudo -u gitlab-runner docker ps"
