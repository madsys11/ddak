import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { label: string; action: () => void } | "separator";
export type MenuState = { x: number; y: number; items: MenuItem[] };

// WebView 기본 오른쪽 클릭 메뉴(Look Up, Translate, Search with Google 등)를 띄우지 않는다.
// 글 입력란은 잘라내기·붙여넣기·맞춤법을 쓰도록 남긴다. 터미널의 숨은 입력란(xterm)은 입력란으로 보지 않는다.
// 캡처 단계에서 막아 아래 요소가 전파를 멈춰도 빠지지 않는다. 앱이 그리는 메뉴(아래 ContextMenu)는 그대로 열린다.
// 글 입력란에서는 전파를 멈춘다: 탭·파일 이름 입력란은 앱 메뉴를 여는 행 안에 있어서, 그 행이 기본 메뉴를 취소한다 (리뷰 R1).
export function refuseNativeMenu(target: Window = window) {
  const refuse = (e: MouseEvent) => {
    const el = e.target;
    const typing =
      (el instanceof HTMLTextAreaElement && !el.classList.contains("xterm-helper-textarea")) ||
      (el instanceof HTMLInputElement && el.type !== "checkbox");
    if (typing) e.stopPropagation();
    else e.preventDefault();
  };
  target.addEventListener("contextmenu", refuse, true);
  return () => target.removeEventListener("contextmenu", refuse, true);
}

// 오른쪽 클릭 메뉴. 네이티브 팝업 대신 화면 안에 그린다 (자체 테스트가 누를 수 있게).
// 바깥을 누르거나 Esc, 창 크기 변경이면 닫힌다.
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // 창 밖으로 나가지 않게 그린 뒤 크기를 보고 옮긴다.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 4), top: Math.min(menu.y, window.innerHeight - r.height - 4) });
  }, [menu]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-sep" />
        ) : (
          <div
            key={i}
            className="context-item"
            onClick={() => {
              onClose();
              item.action();
            }}
          >
            {item.label}
          </div>
        ),
      )}
    </div>
  );
}
