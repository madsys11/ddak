# 터미널 글자 대비 (Solarized Light가 흐림)

대상: 기준 8ff6652, 커밋하지 않은 변경 (`src/Terminal.tsx`, `src/selftest.ts`, `docs/spec.md`).

## 문제와 원인

사용자: Solarized Light 테마에서 터미널 글씨가 너무 흐리다.

배경 `#FDF6E3` 기준 대비 (계산): 기본 글자 `#657B83` 4.13:1, 노랑·초록·청록·파랑 약 3:1, brightCyan `#93A1A1` 2.48:1.
비교: Light 기본 글자 11.2:1, Dark 10.3:1.

## 수정

xterm `minimumContrastRatio: 4.5` (VS Code 터미널 기본값, 사용자 결정). 테마 색표는 그대로 두고 그릴 때 진하게 한다.

확인: 자체 테스트 `terminalContrast`가 Solarized 터미널 색에서 brightCyan으로 쓴 글자의 가장 진한 불투명 픽셀을 WebGL
캔버스에서 잰다. 수정이 있으면 rgb(95,104,104) 5.31:1 통과, 끄면 rgb(147,161,161) 2.48:1 실패.

시행착오: █로 재면 보정되지 않는다 (xterm이 블록·상자 문자를 뺀다). 투명 픽셀은 0,0,0으로 읽혀서 처음 테스트는 수정 여부와
관계없이 검은색을 읽었다. 불투명 픽셀만 본다.

## 리뷰 지적

### R3 (P3) 흐린 글자(SGR 2) 예외를 스펙에 적기

판단: 타당. `@xterm/addon-webgl` `TextureAtlas.ts`와 `DomRendererRowFactory.ts`가 dim 글자에는 `minimumContrastRatio / 2`를
쓴다 (보통 글자와 구분되게). 4.5에서 dim 목표는 2.25:1.

수정: `docs/spec.md` 테마 항목에 dim 예외를 적었다. 코드는 그대로 (xterm 기본 의미).
