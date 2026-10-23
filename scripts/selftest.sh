#!/bin/zsh
# 실제 앱을 자체 테스트 모드로 띄워 시나리오를 돌린다. 결과는 표준 출력, 종료 코드 0이면 통과.
# 사용법: scripts/selftest.sh
set -e
cd "$(dirname "$0")/.."

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

# 개발용으로 띄워 둔 앱(1420)과 같이 돌 수 있게 포트를 따로 쓴다.
port=1430
config="{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npm run dev -- --port $port\"}}"

# 시나리오 하나 = 앱 한 번 실행. 앱 데이터 폴더를 시나리오마다 따로 둔다.
run() {
  local scenario=$1 data="$base/data-$1"
  echo "--- $scenario" >&2
  DDAK_SELFTEST="$root" DDAK_SELFTEST_SCENARIO="$scenario" DDAK_DATA_DIR="$data" DDAK_HOME="$base/home-$1" \
    npx tauri dev --no-watch --config "$config" 2>&1 \
    | sed -n '/=== DDAK SELFTEST BEGIN ===/,/=== DDAK SELFTEST \(PASS\|FAIL\) ===/p' \
    | tee /dev/stderr | grep -q "=== DDAK SELFTEST PASS ==="
}

mkdir -p "$base/data-main" "$base/data-restart" "$base/data-corrupt"
# 다시 켜기: 지난번 목록에 없어진 폴더(gone)가 있고, 그것이 활성이었다.
printf '{"projects":[{"path":"%s"},{"path":"%s"}],"active":"%s"}' "$root" "$base/gone" "$base/gone" > "$base/data-restart/projects.json"
# 깨진 목록 파일
printf '{"projects": [' > "$base/data-corrupt/projects.json"
# 작업그룹 설정. 진짜 claude·codex를 띄우지 않도록 테스트용 그룹을 기본으로 둔다 (corrupt는 기본 설정 생성을 본다).
# main: 셸 하나 (기존 시나리오가 터미널 하나로 시작한다고 가정)
# (shiftEnter: 셸에서 ⇧↩ 동작을 보려고 켠다)
printf '%s' '{"default":"test","groups":[{"id":"test","name":"Test","sessions":[{"name":"shell","shiftEnter":"\u001b\r"}]}]}' > "$base/data-main/groups.json"
# restart: 세 세션 — 인자 전달(작은따옴표, 공백), 읽기 전용 표시, 없는 명령
cat > "$base/data-restart/groups.json" <<'JSON'
{"default":"trio","groups":[{"id":"trio","name":"Trio","sessions":[
  {"name":"alpha","command":"printf","args":["ALPHA %s|\\n","it's quoted"]},
  {"name":"beta","command":"sh","args":["-c","echo \"BETA $0\"","x  y"],"readOnly":true},
  {"name":"gamma","command":"ddak-no-such-cli"}
]}]}
JSON

# 하나가 실패해도 나머지를 다 돌리고, 끝에 하나라도 실패했으면 실패로 끝낸다.
failed=0
for scenario in main restart corrupt; do
  run $scenario || failed=1
done
exit $failed
