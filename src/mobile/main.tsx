import React from "react";
import ReactDOM from "react-dom/client";
import { applyTheme } from "../themes";
import { MobileApp } from "./MobileApp";
import { locale } from "./i18n";
import "./mobile.css";

// 데스크톱과 같은 테마 토큰. 폰 설정의 밝기를 따른다.
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => {
  applyTheme(dark.matches ? "dark" : "solarized-light");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--tabbar-bg").trim());
};
theme();
dark.addEventListener("change", theme);
document.documentElement.lang = locale;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);
