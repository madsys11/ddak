import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 폰 화면 (src/mobile, docs/mobile-plan.md). 정적 파일로 빌드해 고정 주소(GitHub Pages)에 올린다.
// 데스크톱 앱(vite.config.ts)과 따로 빌드한다: Tauri 번들에는 넣지 않는다.
export default defineConfig({
  plugins: [react()],
  root: "src/mobile",
  // Pages의 하위 경로(/ddak/)에서도, 개발 서버에서도 되게 상대 경로로
  base: "./",
  build: {
    outDir: "../../dist-mobile",
    emptyOutDir: true,
  },
  server: {
    port: 1430,
    strictPort: true,
  },
});
