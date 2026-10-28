import React from "react";
import ReactDOM from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { locale } from "./i18n";
import { applySettings, loadSettings } from "./settings";
import "./mobile.css";

// 데스크톱과 같은 테마 토큰. 설정 화면에서 고른 테마(기본은 폰 설정의 밝기)와 글자 크기.
applySettings(loadSettings());
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applySettings(loadSettings()));
document.documentElement.lang = locale;

// 푸시 받기와 알림 누르기만 하는 서비스 워커 (public/sw.js). 알림을 누르면 그 채팅으로 옮긴다.
// 보고 있는 채팅의 알림을 띄웠다는 알림("shown")은 채팅 화면에 넘긴다 (MobileApp.tsx Chat이 닫는다).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("service worker", e));
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open" && typeof e.data.path === "string" && e.data.path.startsWith("#/")) location.hash = e.data.path.slice(1);
    if (e.data?.type === "shown" && typeof e.data.tag === "string") dispatchEvent(new CustomEvent("ddak-shown", { detail: { tag: e.data.tag, kind: e.data.kind, id: e.data.id } }));
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
