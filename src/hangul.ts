import type { Terminal } from "@xterm/xterm";

// macOS WebKit(WKWebView)에서 한글 등 입력기 글자를 터미널로 보내는 보정.
//
// 진단 (2026-10-23, 실제 앱에서 "한 " 입력 기록): composition 이벤트가 하나도 오지 않는다. 키마다
//   beforeinput/input → keydown(keyCode 229) → keyup
// 순서이고, 첫 자모는 insertText "ㅎ", 이후 조합은 insertReplacementText "하" → "한" (앞 글자 바꾸기)로 온다.
//
// xterm이 그대로 처리하면 두 가지가 깨진다 (@xterm/xterm src/browser/CoreBrowserTerminal.ts `_inputEvent`):
// - 바꾸기를 버려서 첫 자모만 들어간다 ("한" → "ㅎ").
// - insertText도 "키를 누른 채(keydown 뒤 keyup 전)"면 버린다. 빠르게 치면 앞 키를 떼기 전에 다음 키의 입력이
//   와서 새 음절의 첫 자모가 사라진다 (자체 테스트로 재현: "한글" → "[글]").
//
// 보정: 입력란에 들어온 글자는 여기서 보낸다. xterm에는 input 이벤트를 넘기지 않는다.
// - insertText: 그 글자를 보낸다. 단 이번 키를 xterm이 이미 보냈으면 (영문 키의 keypress, 스페이스 등) 건너뛴다.
// - insertReplacementText: 입력란 값의 바뀌기 전후를 비교해 바뀐 글자 수만큼 DEL + 새 글자 (ㅎ → DEL하 → DEL한).
//   셸·claude·codex 입력줄은 DEL을 한 글자 지우기로 처리해서 조합 중인 글자가 바로 보인다.
// - composition 이벤트를 쓰는 입력기(일본어 등)는 건드리지 않고 xterm에 맡긴다.
// - keyCode 229 keydown은 xterm에 넘기지 않는다. xterm은 이때 입력란 값을 비교해서 따로 보내는데
//   (CompositionHelper `_handleAnyTextareaChanges`), 여기서 보낸 것과 겹친다.
//
// xterm에 넘길 키인지 (Terminal이 attachCustomKeyEventHandler로 쓴다. 이 함수는 xterm에 하나만 걸 수 있다)
export const passesImeKey = (ev: KeyboardEvent) => !(ev.type === "keydown" && ev.keyCode === 229 && !ev.isComposing);

// el: 입력란을 담은 요소. capture 단계에서 입력란(xterm의 리스너)보다 먼저 받기 위해 조상에 단다.
export function fixImeInput(term: Terminal, el: HTMLElement, textarea: HTMLTextAreaElement) {
  let before = "";
  // 이번 키를 처리하는 동안(keydown과 같은 작업 안: keypress, input까지) xterm이 키를 직접 보냈는지.
  // onData가 아니라 onKey로 센다: onData에는 터미널 질의 응답·포커스 알림·붙여넣기도 섞여 있어서, 키 구간에
  // 그런 응답이 오면 입력기 글자를 빠뜨렸다 (리뷰 지적 3). onKey는 xterm이 키를 처리해 보낼 때만 온다
  // (CoreBrowserTerminal.ts `_keyDown`·`_keyPress`). 여기서 보내는 term.input도 onKey를 일으키지 않는다.
  // 입력기 글자는 keydown보다 먼저 오므로 (위 순서) 앞 키의 결과가 남아 있으면 안 된다 → 키 구간이 끝나면 지운다.
  let xtermSent = false;
  let inKey = false;
  const send = (data: string) => term.input(data, true);
  const sent = term.onKey(() => {
    if (inKey) xtermSent = true;
  });

  const onKeyDown = (e: Event) => {
    if (e.target !== textarea) return;
    xtermSent = false;
    inKey = true;
    // 같은 작업 안의 keypress·input이 끝난 뒤 닫는다 (마이크로태스크는 리스너 사이에 돌아서 안 된다)
    setTimeout(() => {
      inKey = false;
      xtermSent = false;
    });
  };
  const onBeforeInput = (e: Event) => {
    if (e.target === textarea) before = textarea.value;
  };
  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    if (ev.target !== textarea || ev.isComposing || ev.inputType.startsWith("insertComposition")) return;
    if (ev.inputType === "insertText" && ev.data) {
      ev.stopPropagation();
      if (!xtermSent) send(ev.data);
    } else if (ev.inputType === "insertReplacementText") {
      ev.stopPropagation();
      // 코드 포인트 단위로 비교한다. UTF-16 단위로 비교하면 😀 → 😁처럼 앞 반쪽(서로게이트)이 같은 글자에서
      // 반쪽만 보내게 된다 (리뷰 지적 4).
      const [b, a] = [Array.from(before), Array.from(textarea.value)];
      let prefix = 0;
      while (prefix < b.length && prefix < a.length && b[prefix] === a[prefix]) prefix++;
      if (prefix === b.length && prefix === a.length) return; // 같은 글자로 바꿈
      // 바꾸기는 입력란 끝에서 일어난다고 본다 (xterm 입력란은 늘 끝에 덧붙인다). 처음 달라진 곳부터 끝까지를 바꾼다.
      send("\x7f".repeat(b.length - prefix) + a.slice(prefix).join(""));
    }
  };
  el.addEventListener("keydown", onKeyDown, true);
  el.addEventListener("beforeinput", onBeforeInput, true);
  el.addEventListener("input", onInput, true);
  return () => {
    sent.dispose();
    el.removeEventListener("keydown", onKeyDown, true);
    el.removeEventListener("beforeinput", onBeforeInput, true);
    el.removeEventListener("input", onInput, true);
  };
}
