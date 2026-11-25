import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // 빌드 목표 es2021: ||= 등을 낮추지 않는다. 기본(es2020 포함)이면 esbuild 0.25 압축이 xterm requestMode의 ||= 를 낮추며
  // 선언을 지워 ReferenceError로 터미널이 멈췄다 (DECRQM을 묻는 codex 0.172). 맥 최소 버전 11.0(Safari 14)과 맞춘다
  // (tauri.conf.json). 결과는 scripts/check-bundle.mjs가 본다 (docs/reviews/2026-11-25-bundle-target.md)
  build: {
    target: "es2021",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
