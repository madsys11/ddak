import { useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { useT } from "./prefs";

// 터미널 검색 막대 (⌘F, 터미널 메뉴 "찾기"). 입력하면 바로 찾고 (지금 결과를 넓혀 가며), ↩ 다음, ⇧↩ 이전, Esc 닫기.
// 일치는 모두 강조하고 몇 번째인지 센다 (decorations가 있어야 onDidChangeResults가 온다). 색은 테마 토큰
// (--search-match, --search-match-active, #RRGGBB여야 한다).
// 좁은 창에서 addon이 "only accepts positive integers"로 터지는 일이 있다 (orca terminal-search-safe-find.ts): 감싸서 무시한다.
// onFocus: 입력란에 포커스가 오면 이 창을 고른 창으로 (분할 창에서 다른 창의 검색 입력란을 눌렀을 때, 리뷰 R2)
export function TerminalSearch({ term, search, onClose, onFocus }: { term: XTerm; search: SearchAddon; onClose: () => void; onFocus: () => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);

  const options = (incremental: boolean): ISearchOptions => {
    const css = getComputedStyle(document.documentElement);
    const match = css.getPropertyValue("--search-match").trim();
    const active = css.getPropertyValue("--search-match-active").trim();
    return {
      caseSensitive,
      regex,
      incremental,
      decorations: { matchBackground: match, matchOverviewRuler: match, activeMatchBackground: active, activeMatchColorOverviewRuler: active },
    };
  };
  const find = (backward: boolean, incremental = false) => {
    if (!query) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      if (backward) search.findPrevious(query, options(false));
      else search.findNext(query, options(incremental));
    } catch {
      // 잘못된 정규식(애드온이 RegExp 예외를 그대로 던지고 결과 이벤트는 없다)이나 좁은 창의 addon 오류 (위 주석): 결과 없음.
      // 그대로 두면 이전 결과 수가 남았다 (리뷰 R1)
      search.clearDecorations();
      setResult({ index: -1, count: 0 });
    }
  };

  useEffect(() => {
    const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => setResult({ index: resultIndex, count: resultCount }));
    input.current?.focus();
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  // 입력이나 옵션이 바뀌면 다시 찾는다 (입력 중에는 지금 결과를 넓혀 간다). 애드온은 검색어가 같으면 옵션이 바뀌어도
  // 일치 목록을 다시 만들지 않아서 (대소문자 구분을 켜도 수가 그대로였다) 먼저 지운다
  useEffect(() => {
    search.clearDecorations();
    find(false, true);
  }, [query, caseSensitive, regex]);

  const close = () => {
    onClose();
    term.focus();
  };
  // 찾지 못함(-1)이나 정규식 오류는 "결과 없음"
  const count = !query || !result ? "" : result.count === 0 || result.index < 0 ? t("search.none") : t("search.count", { i: result.index + 1, n: result.count });
  return (
    <div className="terminal-search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={query}
        placeholder={t("search.placeholder")}
        spellCheck={false}
        onFocus={onFocus}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            find(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="terminal-search-count" data-count>
        {count}
      </span>
      <button className={caseSensitive ? "on" : ""} data-option="case" title={t("search.caseSensitive")} aria-pressed={caseSensitive} onClick={() => setCaseSensitive((v) => !v)}>
        Aa
      </button>
      <button className={regex ? "on" : ""} data-option="regex" title={t("search.regex")} aria-pressed={regex} onClick={() => setRegex((v) => !v)}>
        .*
      </button>
      <button data-action="prev" title={t("search.previous")} onClick={() => find(true)}>
        ↑
      </button>
      <button data-action="next" title={t("search.next")} onClick={() => find(false)}>
        ↓
      </button>
      <button data-action="close" title={t("search.close")} onClick={close}>
        ×
      </button>
    </div>
  );
}
