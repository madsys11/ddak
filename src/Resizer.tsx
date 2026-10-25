import { usePointerTrack } from "./pointerTrack";
import { useT } from "./prefs";

// 패널의 가로 크기를 끌어서 바꾸는 막대. edge: 패널의 어느 쪽 끝에 붙는지 (파일 트리는 오른쪽, 채팅 패널은 왼쪽).
// 끄는 동안 min~max로 자르고, 더블클릭하면 기본 크기로 (onReset). 끌기의 끝 정리(취소, 창 밖에서 뗌, 언마운트)는
// pointerTrack.ts (리뷰 R1: pointerup만 받아서 창 밖에서 뗀 뒤 돌아오면 누르지 않아도 폭이 바뀌었다).
export function Resizer({ edge, width, min, max, onWidth, onReset }: {
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  onWidth: (width: number) => void;
  onReset: () => void;
}) {
  const t = useT();
  const trackPointer = usePointerTrack();
  function start(e: React.PointerEvent) {
    e.preventDefault();
    const [x0, w0, sign] = [e.clientX, width, edge === "right" ? 1 : -1];
    trackPointer(
      (ev) => onWidth(Math.round(Math.min(max, Math.max(min, w0 + sign * (ev.clientX - x0))))),
      () => document.body.classList.remove("resizing"),
    );
    // trackPointer가 이전 끌기를 먼저 끝내므로 (그 끝 정리가 클래스를 지운다) 그 뒤에 붙인다 (리뷰 R2)
    document.body.classList.add("resizing");
  }
  return (
    <div
      className={`panel-resizer ${edge}`}
      title={t("panel.resizeHint")}
      onPointerDown={start}
      // 누르는 동안 포커스(터미널·입력란)를 빼앗지 않게
      onMouseDown={(e) => e.preventDefault()}
      onDoubleClick={onReset}
    />
  );
}
