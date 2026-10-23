import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { label: string; action: () => void } | "separator";
export type MenuState = { x: number; y: number; items: MenuItem[] };

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
