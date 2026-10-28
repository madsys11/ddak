// 고정폭 글꼴: D2Coding (naver/d2-coding-font VER1.4.0, SIL OFL 1.1). 터미널과 화면의 고정폭 글자가 쓴다.
// Menlo는 맥에만 있어 Windows에서는 다른 글꼴로 대체되어 두 OS의 모양이 달랐다. 앱에 넣어 어디서나 같게 한다.
// 배포된 원본 TTF를 그대로 쓴다: 저작권(name 0)·라이선스(name 13·14)가 파일 안에 있고, 형식을 바꾸거나 일부만 넣으면
// OFL의 예약 이름(D2Coding) 때문에 따져야 할 것이 생긴다 (docs/reviews/2026-10-28-mono-font.md).
import regularUrl from "./assets/fonts/D2Coding-Ver1.4.0-20261003.ttf?url";
import boldUrl from "./assets/fonts/D2CodingBold-Ver1.4.0-20261003.ttf?url";

export const MONO_FAMILY = "D2Coding";
// 글꼴을 못 불러오면 예전처럼 Menlo(맥)·시스템 고정폭으로
export const MONO_FONT = `"${MONO_FAMILY}", Menlo, monospace`;

// 앱이 넣은 글꼴 면. 자체 테스트가 이것이 불러와졌는지 직접 본다 (PC에 설치된 D2Coding이 실패를 가리지 않게).
export const monoFaces = [
  new FontFace(MONO_FAMILY, `url("${regularUrl}")`, { weight: "400" }),
  new FontFace(MONO_FAMILY, `url("${boldUrl}")`, { weight: "700" }),
];

// 첫 화면 전에 부른다. xterm은 터미널을 열 때 글자 폭을 재므로 그 전에 글꼴이 있어야 한다.
// 실패해도 앱은 대체 글꼴로 뜬다 (경고만 남긴다).
export async function loadMonoFont() {
  document.documentElement.style.setProperty("--mono-font", MONO_FONT);
  for (const face of monoFaces) document.fonts.add(face);
  const results = await Promise.allSettled(monoFaces.map((face) => face.load()));
  for (const r of results) if (r.status === "rejected") console.warn("고정폭 글꼴을 불러오지 못함", r.reason);
}
