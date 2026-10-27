#!/bin/zsh
# 실제 앱을 자체 테스트 모드로 띄워 시나리오를 돌린다. 결과는 표준 출력, 종료 코드 0이면 통과.
# 사용법: scripts/selftest.sh
set -e
cd "$(dirname "$0")/.."
# 도는 동안 맥이 잠들지 않게 한다 (잠들면 앱의 타이머까지 멈춰 결과 없이 멈춘다. 2026-10-25). 이 스크립트가 끝나면 풀린다.
caffeinate -dims -w $$ &

# base/proj: 테스트할 프로젝트, base/other: 두 번째 프로젝트, base/data-<시나리오>: 앱 데이터(프로젝트 목록),
# base/home-<시나리오>: ~/.ddak 대신 (작업그룹 worktree)
base=$(mktemp -d -t ddak-selftest)
trap 'rm -rf "$base"' EXIT
base=$(cd "$base" && pwd -P) # /var → /private/var. 셸의 pwd와 맞추기 위해
root="$base/proj"
# (프로젝트 폴더에 .git을 두지 않는다. 있으면 프로젝트 자체가 저장소로 잡혀 작업그룹 worktree가 달라진다.
#  .git 숨기기는 Rust 단위 테스트가 본다)
mkdir -p "$root/A_dir" "$root/b_dir" "$base/other"
touch "$root/a.txt" "$root/z.txt" "$root/.DS_Store" "$root/A_dir/inner.txt"
# server: 저장소, web: server의 worktree (파일 트리 아이콘 확인용)
git init -q "$root/server"
git -C "$root/server" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git -C "$root/server" worktree add -q "$root/web"
# linked: 프로젝트 밖의 저장소 (저장소 연결·clone 원본)
git init -q "$base/linked"
git -C "$base/linked" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init

# 개발용으로 띄워 둔 앱(1420)과 같이 돌 수 있게 포트를 따로 쓴다. 다른 worktree의 자체 테스트와 겹치면 SELFTEST_PORT로 바꾼다.
port=${SELFTEST_PORT:-1430}
# 창은 앱 설정의 창에 웹뷰의 백그라운드 절전 끄기만 더한다: 맥 화면이 잠긴 뒤 띄운 창은 WebKit이 타이머를 멈춰
# 테스트가 진행되지 않는다 (2026-10-27)
windows=$(python3 -c 'import json,sys; w=json.load(open(sys.argv[1]))["app"]["windows"]; [x.update(backgroundThrottling="disabled") for x in w]; print(json.dumps(w))' src-tauri/tauri.conf.json)
config="{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npm run dev -- --port $port\"},\"app\":{\"windows\":$windows}}"

# 시나리오 하나 = 앱 한 번 실행. 앱 데이터 폴더를 시나리오마다 따로 둔다 (둘째 인자: 같이 쓸 폴더 이름).
run() {
  local scenario=$1 dirs=${2:-$1}
  echo "--- $scenario" >&2
  # 모바일 연결은 Tailscale 없이 정한 이름·로그인으로, OS가 고른 포트에서 (실제 앱과 겹치지 않게. src-tauri/src/mobile.rs)
  # claude 세션 표시(CLAUDE_CODE_CHILD_SESSION 등)는 터미널에 넘기지 않는지, 다른 CLAUDE 변수는 넘기는지 본다 (testTerminal)
  CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=selftest CLAUDE_CODE_DDAK_SELFTEST=keep \
  DDAK_MOBILE_IDENTITY="selftest.tail0.ts.net|selftest@example.com" DDAK_MOBILE_PORT=0 DDAK_MOBILE_SCREEN="https://screen.example/ddak/" \
  DDAK_SELFTEST="$root" DDAK_SELFTEST_SCENARIO="$scenario" DDAK_SELFTEST_ONLY="${SELFTEST_ONLY:-}" DDAK_DATA_DIR="$base/data-$dirs" DDAK_HOME="$base/home-$dirs" \
    npx tauri dev --no-watch --config "$config" 2>&1 \
    | sed -n '/=== DDAK SELFTEST BEGIN ===/,/=== DDAK SELFTEST \(PASS\|FAIL\) ===/p' \
    | tee /dev/stderr | grep -q "=== DDAK SELFTEST PASS ==="
}

mkdir -p "$base/data-main" "$base/data-restart" "$base/data-corrupt" "$base/data-resume"
# 다시 켜기: 지난번 목록에 없어진 폴더(gone)가 있고, 그것이 활성이었다.
printf '{"projects":[{"path":"%s"},{"path":"%s"}],"active":"%s"}' "$root" "$base/gone" "$base/gone" > "$base/data-restart/projects.json"
# 깨진 목록 파일
printf '{"projects": [' > "$base/data-corrupt/projects.json"
# 작업그룹 설정. 진짜 claude·codex를 띄우지 않도록 테스트용 그룹을 기본으로 둔다 (corrupt는 기본 설정 생성을 본다).
# main: 셸 하나 (기존 시나리오가 터미널 하나로 시작한다고 가정)
# (shiftEnter: 셸에서 ⇧↩ 동작을 보려고 켠다)
printf '%s' '{"default":"test","shiftEnterFor":{"cat":"\u001b\r"},"groups":[{"id":"test","name":"Test","sessions":[{"name":"shell","shiftEnter":"\u001b\r"}]}]}' > "$base/data-main/groups.json"
# restart: 세 세션 — 인자 전달(작은따옴표, 공백), 읽기 전용 표시, 없는 명령
cat > "$base/data-restart/groups.json" <<'JSON'
{"default":"trio","groups":[{"id":"trio","name":"Trio","sessions":[
  {"name":"alpha","command":"printf","args":["ALPHA %s|\\n","it's quoted"]},
  {"name":"beta","command":"sh","args":["-c","echo \"BETA $0\"","x  y"],"readOnly":true},
  {"name":"gamma","command":"ddak-no-such-cli"}
]}]}
JSON

printf '{"projects":[{"path":"%s"}],"active":"%s"}' "$root" "$root" > "$base/data-resume/projects.json"
# claude 설정 대신 (src-tauri/src/claude_trust.rs): 원본 프로젝트를 신뢰한 상태. 작업그룹을 만들면 그 폴더도 신뢰로 적힌다
mkdir -p "$base/home-main"
printf '{"projects":{"%s":{"hasTrustDialogAccepted":true,"keep":1}}}' "$root" > "$base/home-main/claude.json"
# resume: 두 번 켠다 (resume-save가 남긴 상태를 resume-check가 복원). keeps는 복원 인자로 이어 가고,
# fresh는 복원 인자가 실패해 처음 인자로 돌아간다. keeps의 역할(KP1)은 둘 사이에 KP2로 바꾼다: 복원은 세션을 만들 때
# 저장한 프롬프트({prompt})를 써야 한다.
duo='{"default":"duo","groups":[{"id":"duo","name":"Duo","sessions":[
  {"name":"keeps","role":"ROLE","command":"sh","args":["-c","echo \"FIRST {session}\""],"resume":["-c","echo \"RESUMED {session} {prompt}\""]},
  {"name":"fresh","command":"sh","args":["-c","echo \"FRESH {session}\""],"resume":["-c","exit 1"]}
]}]}'
print -r -- "${duo/ROLE/KP1}" > "$base/data-resume/groups.json"

# 하나가 실패해도 나머지를 다 돌리고, 끝에 하나라도 실패했으면 실패로 끝낸다.
failed=0
# SELFTEST_SCENARIOS로 일부만 돌릴 수 있다 (예: "main", "resume").
# SELFTEST_ONLY로 main의 단계를 고른다 (예: "addSession gitGraph". 기본 단계는 늘 돈다. src/selftest.ts runSelftest)
only=${SELFTEST_SCENARIOS:-main restart corrupt resume}
for scenario in main restart corrupt; do
  [[ " $only " == *" $scenario "* ]] && { run $scenario || failed=1; }
done
if [[ " $only " == *" resume "* ]]; then
  run resume-save resume || failed=1
  print -r -- "${duo/ROLE/KP2}" > "$base/data-resume/groups.json"
  run resume-check resume || failed=1
fi
exit $failed
