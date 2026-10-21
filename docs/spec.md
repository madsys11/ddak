# ddak 스펙

> 최초 작성: 2026-10-21
> 상태: 기획 단계 (코드 없음)

## 배경

VS Code + Claude Code 조합은 대부분의 기능이 불필요하고, 필요한 기능은 없으면서 무겁다.
필요한 기능만 담은 가벼운 개인용 AI 작업 도구를 직접 만든다.

이름 `ddak` = "딱 필요한 것만". 실행 명령어 이름으로도 사용한다.

## 핵심 개념

```
프로젝트 (폴더)
 ├─ 저장소들: server, app, web, docs ...
 ├─ 세션들: 각 세션 = 터미널 1개 + git worktree 1개 + 메인 에이전트 1개
 └─ 채팅방 1개: 프로젝트의 모든 세션과 사용자가 참여
```

- **프로젝트**: 파일 트리에서 만드는 최상위 폴더. 그 안에 관련 저장소를 추가한다.
- **세션**: 저장소의 worktree에서 여는 터미널. 세션마다 메인 에이전트가 하나씩 돈다.
- **메인 에이전트**: 세션마다 다른 모델을 쓸 수 있다 (동시에 여러 모델 사용이 목표).
- **서브 에이전트**: 각 세션의 에이전트가 자체적으로 사용한다. ddak이 관여하지 않는다.
- **채팅방**: 프로젝트마다 하나. 세션끼리 대화하며 협업하고, 사용자도 참여한다.

## 기능 범위

### 1차 (필수)

1. **파일 트리** — VS Code 수준의 파일 탐색. 프로젝트 폴더 생성, 저장소 추가.
2. **다중 터미널** — 여러 개의 터미널을 동시에 연다.
3. **worktree 기반 세션** — 세션 생성 시 git worktree를 만들고 그 경로에서 터미널을 연다.
4. **프로젝트 채팅방** — 세션 간 / 메인 에이전트 간 / 사용자와의 대화.
5. **git graph** — 커밋 그래프 보기. 어떤 세션이 어떤 브랜치에서 작업 중인지 표시하면 좋다.

### 나중에 (필요할 때 하나씩)

- 마크다운 뷰어
- 기타 (diff 뷰어 등)

## 세션 실행 방식 (결정: A)

세션은 **기존 CLI(claude, codex, gemini 등)를 터미널(PTY)에서 그대로 실행**한다.
ddak은 터미널·worktree·채팅방만 제공하고, 에이전트 기능은 각 CLI에 맡긴다.

검토한 방식:

- **A. 기존 CLI를 터미널에서 실행 ← 채택**
  - 파일 편집·권한·서브 에이전트·컨텍스트 관리를 CLI가 이미 제공
  - 구독 요금제(Claude Pro/Max, ChatGPT 등) 그대로 사용, API 토큰 과금 없음
  - CLI 업데이트를 바로 누림
  - 단점: 채팅방 연동이 MCP + PTY 깨우기로 간접적, UI는 CLI의 TUI 그대로
- **B. ddak이 직접 에이전트 루프 구현** — 제외
  - 사실상 Claude Code 재구현으로 작업량이 매우 큼, API 토큰 과금
- **C. CLI를 헤드리스로 실행(예: `claude -p --output-format stream-json`) + 자체 UI** — 보류
  - A의 깨우기 방식이 불편해지면 특정 CLI만 C로 전환 검토.
    터미널 구조를 유지한 채 추가할 수 있다.

## 기술 스택 (결정)

**Tauri 2 + React(TypeScript) 프론트엔드 + Rust 백엔드**

프론트엔드는 Solid와 비교 후 React 채택:
가장 무거운 터미널은 xterm.js가 프레임워크와 무관하게 그리므로 성능 차이는 작고,
파일 트리(react-arborist)·마크다운(react-markdown) 등 생태계, AI 코드 품질,
사용자의 React Native 경험에서 React가 유리하다.

| 기능 | 구현 |
|---|---|
| 파일 트리 | 웹 UI + Rust `notify` (파일 감시) |
| 터미널 | 프론트 **xterm.js** + Rust `portable-pty` |
| worktree | `git worktree` CLI 호출 |
| git graph | Rust `gix`로 커밋/레인 계산 → 프론트에서 SVG/Canvas + 가상 스크롤 |
| 채팅방 | 앱 내장 **MCP 서버** (localhost) + SQLite |

### 선택 이유

- 무거움이 출발점이므로 Electron 제외. Tauri는 OS WebView 사용 → 작은 번들, 적은 메모리.
- 터미널이 핵심. Claude Code 같은 TUI를 안정적으로 그리는 검증된 웹 터미널은 xterm.js (VS Code와 동일).

### 검토 후 제외한 대안

- **Electron**: 전부 TS라 개발은 빠르지만 VS Code와 같은 무거움.
- **Flutter 데스크톱**: xterm.dart의 TUI 렌더링 안정성이 xterm.js에 못 미침.
- **Swift 네이티브**: macOS 전용, UI 개발 비용 큼.
- **UI까지 순수 Rust (GPUI + alacritty_terminal 등)**: 가능은 함 (Zed 사례). 그러나
  - GPUI는 문서 부족·API 변동, egui/iced는 위젯을 직접 만들어야 함
  - 터미널 렌더링·선택·한글 IME·스크롤을 직접 구현해야 함
  - 마크다운/diff/하이라이팅 등 이후 기능의 생태계가 웹에 비해 빈약
  - 컴파일 사이클로 UI 반복 개발이 느림
  - AI가 작성하는 GPUI 코드 품질이 웹 UI 대비 낮음
  - 성능 병목이 생기면 그 부분만 Rust로 내리는 전략을 택함

## 배포 계획 (나중에 하나의 단계로 진행)

- 공개 GitHub 저장소(madsys11/ddak)에서 개발한다. 사용자가 먼저 쓰며 다듬고, 이후 팀원(모두 macOS)에게 배포한다.
  그 전까지는 `npm run tauri build`로 만든 앱을 쓴다 (직접 빌드한 앱은 quarantine이 없어 서명 없이 실행된다).
- 저장소에 개인정보를 넣지 않는다. 커밋 작성자는 GitHub noreply 주소를 쓴다 (이 저장소의 로컬 git 설정).
- `tauri-plugin-updater` + GitHub Actions(`tauri-action`) + GitHub Releases(`latest.json`).
  태그 push → 빌드·서명·공증 → 릴리스 → 앱이 업데이트 확인 후 설치
- 업데이트 서명 키 필요. 개인 키는 GitHub Secrets + 별도 백업 (잃으면 기존 설치본에 업데이트 불가)
- Apple Developer 계정 있음 → 배포 시작부터 Developer ID 서명 + 공증.
  준비물: Developer ID Application 인증서(조직 계정이면 Account Holder만 발급 가능),
  공증용 앱 암호 또는 App Store Connect API 키 → GitHub Secrets
- 앱 식별자는 임시값 `dev.ddak.desktop` (`tauri.conf.json`). 배포 전에 확정한다.
  배포 뒤에는 바꾸기 어렵다 (macOS가 다른 앱으로 인식, 설정·권한이 초기화됨).
- 라이선스는 팀 배포 전에 정한다.
- 버전 번호가 `package.json`, `Cargo.toml`, `tauri.conf.json` 세 곳에 있다. 배포 단계에서 한 곳으로 모은다.

## 채팅방 설계

모델 종류와 무관하게 참여시키기 위해 **MCP**를 사용한다
(Claude Code, Codex CLI, Gemini CLI 모두 MCP 지원).

```
ddak 앱
 ├─ 로컬 MCP 서버 (localhost)
 │    도구: post_message, read_messages, list_members
 ├─ SQLite: 프로젝트 → 채팅방 → 메시지
 └─ 터미널 세션들
      ├─ [claude] server 워크트리  ─┐
      ├─ [codex]  web 워크트리     ─┼─ MCP로 같은 채팅방 접속
      └─ [gemini] docs 워크트리    ─┘
```

- **깨우기 문제**: CLI 에이전트는 스스로 채팅방을 확인하지 않는다.
  새 메시지가 오면 ddak이 해당 세션의 PTY에 알림 문구를 입력해 에이전트를 깨운다.
  ddak이 터미널을 직접 소유하기 때문에 가능하다.
- 사용자는 채팅방 UI에서 직접 메시지를 쓴다.

## 미결정 사항

- [x] 세션 실행 방식 → A (기존 CLI를 터미널에서 실행)
- [x] 프론트엔드 프레임워크 → React
- [ ] 깨우기 알림의 구체적 방식 (입력 문구, 에이전트가 작업 중일 때의 처리)
- [ ] 채팅 메시지 형식 (멘션, 스레드 여부 등)

## 진행 상황

- 2026-10-21: Tauri 2 + React 기본 구조 생성. 파일 트리 + 터미널 1개 구현
  - 실행: `npm run tauri dev`
  - 자체 테스트 `scripts/selftest.sh` 통과 (트리 정렬·펼치기, 작업 폴더, 한글 출력/폭, UTF-8, 크기 조절, Claude Code TUI 표시, exit)
  - Vite는 6으로 고정. 이 맥의 Node가 20.10이라 Vite 7+(Node 20.19+ 필요)가 실행되지 않는다.
    Node를 올리면 Vite도 올려도 된다.
  - PTY 출력은 바이트 그대로(Channel + Raw) 프론트로 보낸다. 문자열로 바꾸면 한글이 경계에서 깨진다.

- 2026-10-22: 다중 터미널 — 탭 + 탭 안 분할 (iTerm/VS Code 터미널 방식)
  - 탭 하나 = 분할 트리 하나 (`src/layout.ts`). 터미널은 탭 안에서 모두 형제로 두고
    위치만 바꾼다. 다시 마운트되면 셸이 죽기 때문이다. 숨은 탭은 `display: none`.
  - 단축키: ⌘T 새 탭, ⌘D 오른쪽 분할, ⇧⌘D 아래 분할, ⌘W 터미널 닫기, ⇧⌘W 창 닫기
    (네이티브 메뉴, `src-tauri/src/menu.rs`), ⌘1~9 / ⇧⌘[ ] 탭 이동 (프론트 keydown)
  - WebGL 컨텍스트는 페이지당 수가 제한되어 터미널 20개 남짓에서 손실이 실제로 난다.
    손실되면 기본 DOM 렌더러로 전환한다. 리뷰 대응 기록: `docs/reviews/2026-10-22-multi-terminal.md`
  - 셸이 exit 하면 그 터미널이 닫힌다. 탭의 마지막 터미널이 닫히면 탭도 닫힌다.
  - 자체 테스트는 메뉴 단축키를 실제 키 입력이 아니라 "menu" 이벤트로 흉내 낸다.
    ⌘W가 창을 닫지 않는지, ⌘C/⌘V 복사·붙여넣기는 직접 확인 필요.

- 2026-10-22: 다국어·테마
  - 기본 언어 영어. 사전은 `src/i18n/` — `en.ts`가 기준이고 다른 언어는 `Messages` 타입이라
    키가 빠지면 타입 검사에서 걸린다. 언어 추가 = 사전 파일 + `src/i18n/index.ts`에 한 줄.
  - 네이티브 메뉴 문구도 같은 사전(`menu.*`)에서 프론트가 Rust로 보낸다 (`set_menu`).
    문구가 두 곳에 나뉘지 않게 하려는 것. 프론트가 뜨기 전 잠깐은 Tauri 기본 메뉴가 보인다.
  - 테마: 다크(VS Code Dark Modern), Solarized Light(사용자가 VS Code에서 쓰는 베이지 테마).
    색은 VS Code 앱 안의 테마 파일에서 가져왔다. 정의는 `src/themes.ts` (UI 색 토큰 + 터미널 색).
    예외: Solarized 터미널 선택색은 테마 값(#EEE8D5)이 배경과 거의 같아 목록 선택색을 반투명으로 썼다.
  - 전환: 보기 메뉴 > 테마 / 언어. 선택은 localStorage에 저장 (설정 파일은 필요해지면).

## 다음 단계

1. worktree 기반 세션 생성
