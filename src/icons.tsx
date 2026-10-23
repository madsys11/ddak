// 파일 트리·탭 바 아이콘. 색은 CSS(.icon-*)에서 테마 토큰으로 정한다 (탭 바 버튼 아이콘은 버튼 글자색).

const Svg = ({ className, title, children }: { className: string; title?: string; children: React.ReactNode }) => (
  <svg className={`icon ${className}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden={title ? undefined : true}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

// 프로젝트: 서류 가방
export const ProjectIcon = ({ title }: { title?: string }) => (
  <Svg className="icon-project" title={title}>
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M6 2h4a1 1 0 0 1 1 1v1h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V3a1 1 0 0 1 1-1Zm0 2h4V3H6v1Z"
    />
  </Svg>
);

// 저장소: 책 (GitHub의 저장소 아이콘과 같은 모양)
export const RepoIcon = ({ title }: { title?: string }) => (
  <Svg className="icon-repo" title={title}>
    <path fill="currentColor" d="M3 2.5A1.5 1.5 0 0 1 4.5 1H13v11H4.5a.5.5 0 0 0 0 1H13v1H4.5A1.5 1.5 0 0 1 3 13.5v-11Z" />
  </Svg>
);

// worktree: 브랜치
export const WorktreeIcon = ({ title }: { title?: string }) => (
  <Svg className="icon-worktree" title={title}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="3.5" r="1.5" />
      <circle cx="5" cy="12.5" r="1.5" />
      <circle cx="11" cy="5" r="1.5" />
      <path d="M5 5v6M11 6.5c0 3-6 2-6 4.5" />
    </g>
  </Svg>
);

// 탭 바 버튼: 새 터미널 (프롬프트 >_)
export const TerminalIcon = () => (
  <Svg className="icon-tool">
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8 10.5h3.5" />
    </g>
  </Svg>
);

// 탭 바 버튼: 오른쪽으로 분할 / 아래로 분할 (창 안의 세로·가로 구분선)
export const SplitIcon = ({ dir }: { dir: "row" | "col" }) => (
  <Svg className="icon-tool">
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d={dir === "row" ? "M8 3v10" : "M2 8h12"} />
    </g>
  </Svg>
);

// 파일 트리 펼치기/접기: 오른쪽 꺾쇠. 펼치면 CSS(.tree-twisty.open)가 90° 돌린다 (2026-10-23 시안 C).
export const ChevronIcon = () => (
  <Svg className="icon-chevron">
    <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);
