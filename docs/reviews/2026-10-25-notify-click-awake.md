# 알림 누르면 그 창으로, 작업 중 잠자기 막기 (2026-10-25)

**요청**: orca 비교 보고서 7번의 남은 부분 — 알림을 누르면 그 프로젝트·창으로 이동, 에이전트가 일하는 동안 잠자기 막기.

## 알림 누르기

- 전에는 누르면 ddak이 앞으로 오기만 했다. 기다림 알림이 생겨 알림이 늘었으니 바로 그 창으로 가야 쓸모가 있다.
- `notify::send(project, kind, body, pty)`: 알림마다 ID(`ddak-<pid>-<n>`)와 갈 곳(프로젝트, 터미널)을 적어 둔다 (최근 200개).
  기다림 알림은 그 채팅 토큰의 터미널(`Ptys::pty_of_token`), 메시지·멈춤 알림은 터미널 없음.
- 위임자 `didReceiveNotificationResponse`(UNNotificationResponse feature)가 `clicked(id)`: 메인 창을 보이고 앞으로, 갈 곳을
  `notification-click`으로 보낸다. App은 그 프로젝트로 가고, 터미널이 없으면 채팅 패널을 연다. 그 터미널의 Terminal은
  onReveal → Workspace `reveal`(그 창의 탭을 보이고 그 창을 고름).
- 확인: selftest addSession — asker의 기다림 알림 뒤 새 탭으로 옮겨 갔다가 누르기 흉내(`selftest_click_notification`) →
  원래 탭으로, asker 창이 고른 창. 메시지 알림(poster)을 누르면 닫혀 있던 채팅 패널이 열림. onReveal 연결을 빼면 탭이 그대로
  (2/1), 채팅 열기를 빼면 열리지 않아 실패.
- 누르면 창을 앞으로 가져오므로 자체 테스트의 "창이 앞에 있음"이 켜진다. 뒤 검사가 알림을 기대해서 누른 뒤 끈다.
- 실제 macOS 알림을 눌렀을 때 위임자가 불리는지는 설치 후 확인 (자체 테스트는 번들이 아니라 알림을 보내지 않는다).

## 잠자기 막기

- 자리를 비운 사이 Mac이 잠들면 claude·codex의 작업이 멈춘다. 이제 상태(OSC 7501)로 작업 중인지 안다.
- 프론트가 working이 바뀔 때 `pty_working`. Rust `keep_awake`(깨우기 확인 주기, 0.25초)가 작업 중인 터미널이 있으면
  `/usr/bin/caffeinate -i -w <ddak pid>`를 띄우고, 없으면 끝낸다. 터미널이 닫혀 목록에서 빠지는 것도 같은 주기에 반영된다.
- `-i`: 저절로 잠드는 것만 막는다 (화면 꺼짐·덮개 닫기는 막지 않는다). 기다림(blocked)·대기(idle)·완료(done)는 작업 중이 아니다.
- 확인: Rust keeps_awake_while_working (띄움, 인자 확인, 그대로 유지, 누가 끝내면 다시 띄움, 작업 끝·터미널 닫힘에 끝냄).
  selftest programStatus — working 보고에 caffeinate, idle에 풂. pty_working을 빼면 실패.

## 간헐 실패 (Rust)

- `wake_holds_while_program_awaits_user`가 6번에 1번 "훅이 알린 확인을 또 알림"으로 실패했다. 직전 대기가 끝난 시각과 훅 시각이
  같은 Instant로 찍히면 `h > e`가 거짓이었다 (시계 해상도). 같은 시각도 그 뒤로 보게 `h >= e`로 고쳤다. 12번 연속 통과.

## 리뷰 1차 (#114)

**R1 [P2] 링크 경로로 등록한 프로젝트의 알림 클릭이 무시됨 — 타당.** 채팅방은 프로젝트를 canonicalize하고(pty.rs join_chat)
App은 등록 경로와 글자로 비교했다. 수정: `src/notifyClick.ts` projectForClick — 같으면 그것, 아니면 등록 경로들의 실제 경로
(`real_path` 명령, 없는 경로는 그대로)로 찾아 등록 경로를 돌려준다. activate·채팅 열기는 등록 경로로. 확인: selftest
notifyClickUnit (같음, /tmp↔/private/tmp, 링크↔실제, 없음, 실제 경로 실패), programStatus의 실제 링크로 real_path. 실제 경로 찾기를
빼면 단위 검사 실패. 링크 경로로 등록한 프로젝트를 앱에서 오가며 누르는 끝-끝 검사는 넣지 않았다 (프로젝트를 더하고 지우면 뒤 단계의
목록 검사가 흔들린다).

**R2 [P2] 화면 선택 창을 기다리는 동안 잠자기 막기가 안 풀림 — 타당.** 수정: 작업 중 = OSC working이고 기다리지 않음
(선택 창 포함). 확인: programStatus — 작업 중에 선택 창 → 풂, 닫혀 작업이 이어지면 다시 막음. 고치기 전 (false true)로 실패.

**R3 [P2] 상태 IPC 도착 순서가 뒤집히면 반대로 굳음 — 타당.** 수정: 터미널마다 상태 전송을 한 줄로(statusSends) — idReady를
기다린 뒤 차례로 invoke. 생성 응답 전 상태도 같은 줄에서 기다린다 (따로 보내던 생성 직후 전송은 뺐다). 확인: devHooks.statusDelay로
먼저 보낸 working=true를 0.8초 늦추고 바로 idle → 잠자기 막기 풀림. 줄을 없애면 true가 남아 실패.
