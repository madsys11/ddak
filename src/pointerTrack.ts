import { useEffect, useRef } from "react";

// 끌기는 포인터가 요소 밖으로 나가도 따라가도록 window에서 받는다 (탭 끌기는 끄는 중에 탭 요소가 DOM에서 옮겨져서 포인터
// 캡처도 못 쓴다). 끝나는 경우를 모두 같은 정리로 모은다 (Workspace 리뷰 지적 5, 패널 크기 리뷰 R1): pointerup,
// pointercancel, 버튼이 눌려 있지 않은 움직임 (창 밖에서 떼면 pointerup이 오지 않는다), 언마운트, 새 끌기 시작.
// 돌려주는 함수: trackPointer(onMove, onEnd). onMove는 끝내는 함수(end)도 받는다.
export function usePointerTrack() {
  const endPointer = useRef<(() => void) | null>(null);
  useEffect(() => () => endPointer.current?.(), []);
  return function trackPointer(onMove: (ev: PointerEvent, end: () => void) => void, onEnd?: () => void) {
    endPointer.current?.();
    const move = (ev: PointerEvent) => (ev.buttons === 0 ? end() : onMove(ev, end));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (endPointer.current === end) endPointer.current = null;
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    endPointer.current = end;
  };
}
