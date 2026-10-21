#!/bin/zsh
# 실제 앱을 자체 테스트 모드로 띄워 시나리오를 돌린다. 결과는 표준 출력, 종료 코드 0이면 통과.
# 사용법: scripts/selftest.sh
set -e
cd "$(dirname "$0")/.."

root=$(mktemp -d -t ddak-selftest)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/A_dir" "$root/b_dir" "$root/.git"
touch "$root/a.txt" "$root/z.txt" "$root/.DS_Store" "$root/A_dir/inner.txt"
root=$(cd "$root" && pwd -P) # /var → /private/var. 셸의 pwd와 맞추기 위해

# 개발용으로 띄워 둔 앱(1420)과 같이 돌 수 있게 포트를 따로 쓴다.
port=1430
config="{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npm run dev -- --port $port\"}}"
DDAK_SELFTEST="$root" npx tauri dev --no-watch --config "$config" 2>&1 \
  | sed -n '/=== DDAK SELFTEST BEGIN ===/,/=== DDAK SELFTEST \(PASS\|FAIL\) ===/p' \
  | tee /dev/stderr | grep -q "=== DDAK SELFTEST PASS ==="
