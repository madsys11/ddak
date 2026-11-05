// 글자 속 웹 주소 찾기: 터미널 링크(src/terminalLinks.ts)와 채팅 글(src/ChatText.tsx)이 같이 쓴다.
// 폰 화면도 쓰므로 Tauri API를 들이지 않는다.

export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// 문장 부호로 끝나면 뺀다 ("spec.md." "x.html:")
export const TRAIL_RE = /[.,:;!?)\]}>'"]+$/;

// 글을 웹 주소와 나머지로 나눈다 (순서대로, 이어 붙이면 원래 글). 주소 끝의 문장 부호는 나머지로
export function splitUrls(text: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAIL_RE, "");
    if (!/^https?:\/\/./i.test(url)) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: url, url });
    at = m.index + url.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
