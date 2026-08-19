import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const appVersion = pkg.version || "1.0.0";

let buildSha = "";

// a. 優先嘗試讀取 client/.build-sha 檔案
try {
  const shaFilePath = new URL("./.build-sha", import.meta.url);
  if (existsSync(shaFilePath)) {
    buildSha = readFileSync(shaFilePath, "utf-8").trim();
  }
} catch {
  // 檔案不存在或讀取失敗不中斷建置
}

// b. 若檔案未取到 SHA，降級嘗試從環境變數讀取
if (!buildSha) {
  buildSha = (process.env.VITE_BUILD_SHA || process.env.BUILD_SHA)?.trim() || "";
}

// c. 本機開發備用：從 git 命令取得 SHA
if (!buildSha) {
  try {
    buildSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // git 命令失敗不中斷建置
  }
}

// d. 最終預設值
if (!buildSha) {
  buildSha = "unknown";
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_SHA__: JSON.stringify(buildSha),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5210,
    proxy: {
      "/api": "http://localhost:3210",
      // 共筆 WS：browser 連 location.host/collab，dev 時轉到 Express。
      "/collab": { target: "http://localhost:3210", ws: true },
    },
  },
});
