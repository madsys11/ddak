#!/bin/sh
# 릴리스 빌드를 만들어 /Applications/ddak.app으로 설치한다 (docs/spec.md "배포 계획" 1단계).
# 직접 빌드한 앱은 quarantine이 없어서 서명 없이 실행된다.
#
# ddak 안의 터미널에서 돌려도 된다. 빌드가 끝나면 교체 단계를 ddak 세션 밖의 프로세스로 띄운다 (ddak 터미널을 닫으면 그
# 세션의 프로세스가 모두 끝나서). 그 프로세스가 ddak에 종료를 요청하고, 끝나기를 기다린 뒤 앱을 바꾸고 다시 연다.
# 상태는 바뀔 때마다 저장되고, 다시 열면 세션은 이어서 하기로 복원된다. 교체 기록: $TMPDIR/ddak-install.log
#
# 시험용으로 바꿀 수 있다 (scripts/test-install.sh): DDAK_INSTALL_APP(설치 경로), DDAK_INSTALL_QUIT(종료 요청 명령, 인자는
# 식별자), DDAK_INSTALL_OPEN(여는 명령), DDAK_INSTALL_LOCK(잠금 파일), DDAK_INSTALL_PGREP(프로세스 조회 명령),
# DDAK_INSTALL_FAIL_MOVE·DDAK_INSTALL_FAIL_RESTORE(1이면 새 앱 옮기기·기존 앱 되돌리기를 실패시킨다).
set -eu
cd "$(dirname "$0")/.."
APP=${DDAK_INSTALL_APP:-/Applications/ddak.app}
ID=io.github.madsys11.ddak
OLD_ID=dev.ddak.desktop
LOCK="${DDAK_INSTALL_LOCK:-${TMPDIR:-/tmp}/ddak-install.lock}"

# 세션에서 떼어 낸다: 먼저 fork해서 자식은 프로세스 그룹 리더가 아니게 하고 (리더면 setsid가 반드시 실패한다), 그 자식이
# setsid한다. Perl의 POSIX::setsid는 실패하면 -1(참)이나 undef를 돌려주므로 값을 직접 본다 (리뷰 P2: `or die`가 실패를
# 놓쳤다).
DETACH='exit 0 if fork; my $s = POSIX::setsid(); die "setsid failed: $!\n" if !defined $s || $s < 0; exec @ARGV or die "exec: $!\n";'

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

# 설치 경로의 ddak이 실행 중인지. pgrep: 0 찾음, 1 없음, 그 밖은 조회 오류. 오류면 실행 중인지 모르는 것이라 교체를 멈춘다
# (리뷰 P2: 오류를 "없음"으로 보고 실행 중일 수 있는 앱을 바꿨다).
running() {
  rc=0
  ${DDAK_INSTALL_PGREP:-pgrep} -f "^$APP/Contents/MacOS/ddak" >/dev/null || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
  esac
  echo "ddak이 실행 중인지 확인하지 못해(pgrep 종료 코드 $rc) 바꾸지 않았습니다." >&2
  exit 1
}

quit_app() {
  if [ -n "${DDAK_INSTALL_QUIT:-}" ]; then
    $DDAK_INSTALL_QUIT "$1"
  else
    osascript -e "tell application id \"$1\" to quit" || true
  fi
}

# 교체 단계 (lockf가 잠금을 쥔 채로 부른다, 아래 --replace)
replace() {
  new=$1
  stage=""
  backup=""
  # 준비 폴더는 끝나면 지운다. 기존 앱을 되돌리지 못했으면 그 안의 백업을 남긴다 (keep)
  keep=""
  trap '[ -n "$stage" ] && [ -z "$keep" ] && rm -rf "$stage"' EXIT
  existing=""
  if [ -d "$APP" ]; then
    existing=$(bundle_id "$APP")
    # 있는 것이 ddak일 때만 바꾼다 (예전 식별자 포함)
    case "$existing" in
      "$ID" | "$OLD_ID") ;;
      *)
        echo "$APP 의 식별자가 '$existing'이라 바꾸지 않았습니다." >&2
        exit 1
        ;;
    esac
  fi
  if running; then
    # 설치된 앱의 식별자로 요청한다 (리뷰 P3: 예전 식별자의 앱은 새 식별자로 끝낼 수 없었다)
    echo "ddak에 종료 요청 ($existing)"
    quit_app "${existing:-$ID}"
    i=0
    while running; do
      i=$((i + 1))
      if [ "$i" -gt 60 ]; then
        echo "ddak이 30초 안에 끝나지 않아 교체하지 않았습니다. 직접 끝낸 뒤 다시 돌리세요." >&2
        exit 1
      fi
      sleep 0.5
    done
  fi
  # 실행마다 따로 쓰는 준비 폴더 (같은 볼륨이라 mv가 바로 끝난다)
  stage=$(mktemp -d "$(dirname "$APP")/.ddak-install.XXXXXX")
  ditto "$new" "$stage/ddak.app"
  # 기존 앱은 지우지 않고 옆으로 옮겨 두었다가, 새 앱을 옮기지 못하면 되돌린다 (리뷰 P2: 지운 뒤 옮기다 실패하면 앱이
  # 사라졌다)
  if [ -d "$APP" ]; then
    backup="$stage/old.app"
    mv "$APP" "$backup"
  fi
  if [ "${DDAK_INSTALL_FAIL_MOVE:-}" = 1 ] || ! mv "$stage/ddak.app" "$APP"; then
    if [ -z "$backup" ]; then
      echo "새 앱을 옮기지 못했습니다." >&2
    elif [ "${DDAK_INSTALL_FAIL_RESTORE:-}" != 1 ] && mv "$backup" "$APP"; then
      echo "새 앱을 옮기지 못해 기존 앱으로 되돌렸습니다." >&2
    else
      # 되돌리기도 실패: 백업을 지우지 않고 알린다 (리뷰 P2: 정리가 백업까지 지웠다)
      keep=1
      echo "새 앱을 옮기지도, 기존 앱을 되돌리지도 못했습니다. 기존 앱은 $backup 에 있습니다." >&2
    fi
    exit 1
  fi
  echo "설치함: $APP"
  # claude 안에서 돌렸어도 claude 세션 표시는 빼고 연다. open은 이 환경을 앱에 넘겨서, 다시 연 앱의 터미널 claude가 하위
  # 세션으로 보고 대화 기록을 저장하지 않았다 (2026-10-25). pty.rs도 터미널에 넘기지 않지만 앱에도 남기지 않는다.
  # 이름으로 고른다 (같은 접두사의 CLAUDE_CODE_USE_BEDROCK 등 사용자 설정은 남긴다). 목록은 pty.rs CLAUDE_SESSION_VARS와 같다.
  for k in CLAUDECODE CLAUDE_PID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN; do unset "$k"; done
  ${DDAK_INSTALL_OPEN:-open} "$APP"
}

case "${1:-}" in
  # 교체 단계는 한 번에 하나만 (리뷰 P2: 동시에 돌면 같은 준비 폴더를 서로 지워 앱이 사라졌다). lockf는 잠금(flock)을
  # 쥔 채로 명령을 돌리고, 끝나면 (죽어도) OS가 푼다. 5분 기다려도 못 잡으면 그만둔다.
  --replace)
    exec lockf -k -t 300 "$LOCK" /bin/sh "$PWD/scripts/install.sh" --replace-locked "$2"
    ;;
  --replace-locked)
    replace "$2"
    exit 0
    ;;
  # 세션에서 떼어 낸 채로 나머지 인자를 실행한다 (시험용, 이 셸 대신 perl이 돈다)
  --detach)
    shift
    exec perl -MPOSIX -e "$DETACH" "$@"
    ;;
esac

PATH="$HOME/.cargo/bin:$PATH" npm run tauri build -- --bundles app
built="$PWD/src-tauri/target/release/bundle/macos/ddak.app"
[ -d "$built" ] || { echo "빌드 결과가 없습니다: $built" >&2; exit 1; }
log="${TMPDIR:-/tmp}/ddak-install.log"
nohup perl -MPOSIX -e "$DETACH" /bin/sh "$PWD/scripts/install.sh" --replace "$built" >"$log" 2>&1 &
echo "빌드했습니다. ddak을 끝내고 바꾼 뒤 다시 엽니다 (기록: $log)."
