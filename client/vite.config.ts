import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
const appVersion = pkg.version || "1.0.0";

let buildSha = (process.env.VITE_BUILD_SHA || process.env.BUILD_SHA)?.trim() || "";
if (!buildSha) {
  try {
    buildSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // fallback
  }
}
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
    },
  },
});
