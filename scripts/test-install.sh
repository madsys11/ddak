#!/bin/sh
# scripts/install.sh의 교체 단계와 세션 분리를 시험한다. 설치된 앱은 건드리지 않는다: 임시 폴더에 가짜 앱(실행 파일은
# sleep 링크)을 만들고, 종료 요청·열기 명령을 바꿔 끼운다. 통과하면 종료 코드 0.
set -u
S="$(cd "$(dirname "$0")" && pwd)/install.sh"
T=$(mktemp -d -t ddak-install-test)
trap 'pkill -f "^$T/" 2>/dev/null; rm -rf "$T"' EXIT
fail=0
ok() { echo "PASS  $1"; }
bad() {
  echo "FAIL  $1 ($2)"
  fail=1
}

APP="$T/Applications/ddak.app"
export DDAK_INSTALL_APP="$APP" DDAK_INSTALL_LOCK="$T/lock" DDAK_INSTALL_OPEN=true DDAK_INSTALL_QUIT="$T/quit.sh"
mkdir -p "$T/Applications" "$T/builds"
cat >"$T/quit.sh" <<EOF
#!/bin/sh
echo "\$1" >>"$T/quit.log"
pkill -f "^$APP/Contents/MacOS/ddak"
EOF
chmod +x "$T/quit.sh"

# 가짜 앱: 경로, 식별자, 표시 (어느 빌드인지)
mkapp() {
  mkdir -p "$1/Contents/MacOS"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $2" "$1/Contents/Info.plist" >/dev/null
  # 복사하면 번들 안의 서명 바이너리라 실행하자마자 죽는다 (Killed: 9). 링크는 실행 경로(argv)가 그대로라 pgrep이 찾는다
  ln -s /bin/sleep "$1/Contents/MacOS/ddak"
  echo "$3" >"$1/Contents/marker"
}
marker() { cat "$APP/Contents/marker" 2>/dev/null || echo none; }
leftovers() { find "$T/Applications" -maxdepth 1 -name '.ddak-install.*' | wc -l | tr -d ' '; }
for b in A B C D E; do mkapp "$T/builds/$b.app" io.github.madsys11.ddak "$b"; done

# 1. 새로 설치
sh "$S" --replace "$T/builds/A.app" >/dev/null 2>&1
[ "$(marker)" = A ] && ok "새로 설치" || bad "새로 설치" "$(marker)"

# 1-1. claude 안에서 돌려도 다시 여는 앱에 claude 세션 표시를 넘기지 않는다 (같은 접두사의 사용자 설정과 다른 CLAUDE 변수는 넘긴다)
printf '#!/bin/sh\nenv >"%s"\n' "$T/open.env" >"$T/open.sh"
chmod +x "$T/open.sh"
CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=x CLAUDE_CODE_SESSION_ID=y CLAUDE_CODE_MESSAGING_SOCKET=z CLAUDE_CODE_USE_BEDROCK=1 CLAUDE_CONFIG_DIR=keep \
  DDAK_INSTALL_OPEN="$T/open.sh" \
  sh "$S" --replace "$T/builds/A.app" >/dev/null 2>&1
if [ -s "$T/open.env" ] && ! grep -qE '^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_MESSAGING_SOCKET)=' "$T/open.env" &&
  grep -q '^CLAUDE_CODE_USE_BEDROCK=1$' "$T/open.env" && grep -q '^CLAUDE_CONFIG_DIR=keep$' "$T/open.env"; then
  ok "다시 여는 앱에 claude 세션 표시를 넘기지 않음"
else
  bad "다시 여는 앱의 환경" "$(grep '^CLAUDE' "$T/open.env" 2>/dev/null | tr '\n' ' ')"
fi

# 2. 동시에 둘 (리뷰 P2: 같은 준비 폴더를 서로 지워 앱이 사라졌다). 잠금으로 하나씩, 준비 폴더는 실행마다 따로
sh "$S" --replace "$T/builds/B.app" >"$T/b.log" 2>&1 &
sh "$S" --replace "$T/builds/C.app" >"$T/c.log" 2>&1 &
wait
m=$(marker)
if { [ "$m" = B ] || [ "$m" = C ]; } && [ "$(leftovers)" = 0 ]; then ok "동시에 둘을 설치해도 앱이 남음 ($m)"; else bad "동시 설치" "$m, 남은 준비 폴더 $(leftovers)"; fi

# 3. 새 앱 옮기기가 실패하면 기존 앱으로 되돌린다 (리뷰 P2)
before=$(marker)
if DDAK_INSTALL_FAIL_MOVE=1 sh "$S" --replace "$T/builds/D.app" >/dev/null 2>&1; then
  bad "옮기기 실패" "성공으로 끝남"
elif [ "$(marker)" = "$before" ] && [ "$(leftovers)" = 0 ]; then
  ok "옮기기에 실패하면 기존 앱으로 되돌림"
else
  bad "옮기기 실패" "$(marker), 남은 준비 폴더 $(leftovers)"
fi

# 4. 다른 앱이면 바꾸지 않는다
rm -rf "$APP"
mkapp "$APP" com.example.other X
if sh "$S" --replace "$T/builds/A.app" >/dev/null 2>&1 || [ "$(marker)" != X ]; then bad "다른 앱 거부" "$(marker)"; else ok "다른 앱이면 바꾸지 않음"; fi

# 5. 예전 식별자로 설치된 앱이 실행 중이면 그 식별자로 종료를 요청한다 (리뷰 P3)
rm -rf "$APP"
mkapp "$APP" dev.ddak.desktop OLD
"$APP/Contents/MacOS/ddak" 60 &
sleep 0.3
sh "$S" --replace "$T/builds/E.app" >/dev/null 2>&1
asked=$(cat "$T/quit.log" 2>/dev/null)
if [ "$asked" = dev.ddak.desktop ] && [ "$(marker)" = E ] && ! pgrep -f "^$APP/Contents/MacOS/ddak" >/dev/null; then
  ok "예전 식별자의 실행 중인 앱을 그 식별자로 끝내고 바꿈"
else
  bad "예전 식별자 종료" "요청 '$asked', $(marker)"
fi

# 7. 되돌리기마저 실패하면 기존 앱 백업을 지우지 않고 위치를 알린다 (리뷰 P2)
rm -rf "$APP"
mkapp "$APP" io.github.madsys11.ddak KEEP
DDAK_INSTALL_FAIL_MOVE=1 DDAK_INSTALL_FAIL_RESTORE=1 sh "$S" --replace "$T/builds/A.app" >/dev/null 2>"$T/keep.err"
kept=$(sed -n 's/.*기존 앱은 \(.*\) 에 있습니다.*/\1/p' "$T/keep.err")
if [ -n "$kept" ] && [ "$(cat "$kept/Contents/marker" 2>/dev/null)" = KEEP ]; then ok "되돌리기도 실패하면 백업을 남기고 위치를 알림"; else bad "백업 보존" "$(cat "$T/keep.err")"; fi
[ -n "$kept" ] && rm -rf "$(dirname "$kept")"

# 8. 실행 중인지 조회하지 못하면 (pgrep 오류) 바꾸지 않는다 (리뷰 P2). 처음 확인과 종료를 기다리는 동안 모두
rm -rf "$APP"
mkapp "$APP" io.github.madsys11.ddak STAY
printf '#!/bin/sh\nexit 3\n' >"$T/pgrep-error"
chmod +x "$T/pgrep-error"
if DDAK_INSTALL_PGREP="$T/pgrep-error" sh "$S" --replace "$T/builds/A.app" >/dev/null 2>&1 || [ "$(marker)" != STAY ]; then
  bad "조회 오류 (처음)" "$(marker)"
else
  ok "처음 조회가 오류면 바꾸지 않음"
fi
# 처음에는 찾고(0), 종료를 기다리는 동안 오류(3)
printf '#!/bin/sh\nn=$(cat "%s" 2>/dev/null || echo 0)\necho $((n + 1)) >"%s"\n[ "$n" = 0 ] && exit 0\nexit 3\n' "$T/pgrep-count" "$T/pgrep-count" >"$T/pgrep-later"
chmod +x "$T/pgrep-later"
if DDAK_INSTALL_PGREP="$T/pgrep-later" DDAK_INSTALL_QUIT=true sh "$S" --replace "$T/builds/A.app" >/dev/null 2>&1 || [ "$(marker)" != STAY ]; then
  bad "조회 오류 (기다리는 동안)" "$(marker)"
else
  ok "종료를 기다리는 동안 조회가 오류면 바꾸지 않음"
fi

# 6. 프로세스 그룹 리더에서 시작해도 세션에서 떨어진다 (리뷰 P2: 리더면 setsid가 실패하는데 놓쳤다).
# perl을 그룹 리더로 만든 뒤 (setpgrp 뒤 exec) --detach가 그 perl 자리에서 떼어 내기를 돈다.
mine=$(python3 -c 'import os; print(os.getsid(0))')
perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh "$S" --detach python3 -c "import os; open('$T/sid', 'w').write(str(os.getsid(0)))" 2>"$T/detach.err"
i=0
while [ ! -s "$T/sid" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
theirs=$(cat "$T/sid" 2>/dev/null || echo none)
if [ "$theirs" != none ] && [ "$theirs" != "$mine" ]; then ok "그룹 리더에서 시작해도 새 세션 ($mine → $theirs)"; else bad "세션 분리" "$mine → $theirs $(cat "$T/detach.err")"; fi

[ "$fail" = 0 ] && echo "=== 모두 통과 ===" || echo "=== 실패 있음 ==="
exit "$fail"
