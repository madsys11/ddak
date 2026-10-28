# Git Graph 정렬: --topo-order → --date-order (2026-10-28)

사용자 요청이다. 설계 변경은 사용자가 승인했다.

병합이 많은 저장소에서 그래프가 계단 모양으로 오른쪽으로 끝없이 넓어진다. 예는 master에 develop 쪽을 "운영배포"로
계속 병합하는 저장소다. 사용자 측정(최근 1000개, 최대 레인 수)은 topo-order 209, date-order 12였다.
합쳐진 브랜치를 정리해도 topo-order는 209 그대로였다.

## 원인

레인 계산(`assign_lanes`)은 병합의 두 번째 부모를 기다리는 레인을 열고, 그 커밋이 나올 때까지 닫지 않는다.
`--topo-order`는 한 줄기의 커밋을 몰아서 낸다 (git 문서: "avoid showing commits on multiple lines of history intermixed").
그래서 병합마다 연 레인이 다른 쪽 줄기의 커밋이 나올 때까지 계속 열려 있다.
`--date-order`도 자식이 부모보다 먼저인 것은 지킨다. 레인 계산의 전제가 그대로라 바꿔도 된다.

## 재현 (시험 저장소, 같은 레인 계산을 Python으로 흉내 내어 셈)

| 모양 | topo | date |
|---|---|---|
| develop 커밋 → master로 병합, 되풀이 | 2 | 2 |
| 기능 브랜치를 develop에, develop을 master에 매번 병합 | 3 | 3 |
| master hotfix와 develop으로 되받는 병합 | 2 | 2 |
| **기능 브랜치가 5회차 동안 열려 있다가 develop에 병합, 매 회차 develop → master** | **42** | **8** |
| develop 커밋을 다 쌓은 뒤 master가 오래된 것부터 하나씩 병합 | 2 | 41 |

- 단순히 병합을 되풀이하는 것만으로는 재현되지 않았다. 겹쳐 열린 기능 브랜치가 있어야 topo-order가 넓어진다.
- 마지막 줄은 반대 경우다. 병합 커밋이 모두 develop 커밋보다 새로우면 date-order는 병합들을 먼저 다 내고, 레인이 열린다.
  오래 쌓인 커밋을 나중에 하나씩 병합하는 흐름은 드물다고 보고, 알려진 한계로 둔다.

## 수정

- `git.rs` 그래프 읽기의 `git log --topo-order`를 `--date-order`로 바꿨다. 주석과 `docs/spec.md` Git Graph 항목도 고쳤다.
- 새 시험 `repeated_merges_keep_lanes_narrow`
  - 위 굵은 모양을 30회차 만든다. 같은 초가 없게 시각은 10초씩 올린다.
  - 레인이 10개 이하인지와, 자식이 부모보다 먼저인지(레인 계산의 전제)를 본다.
- `reads_real_repo`는 같은 초의 형제 커밋(side work, rename)의 순서를 고정해 두고 있었다.
  date-order에서는 그 순서가 정해지지 않으므로, 순서 대신 제목으로 커밋을 찾게 고쳤다.

## 확인

- 수정을 끄면(`--topo-order`) 새 시험이 "레인 31개"로 실패하고, 수정 후에는 8개다.
- `cargo test` 전체 128개가 통과했다.
- `SELFTEST_ONLY="gitGraph"` 자체 테스트가 통과했다.
- 바뀐 파일로 고른 자체 테스트는 화면 잠금 때문에 트리 화살표만 실패했다.
- 전체 `scripts/selftest.sh`
  - restart·corrupt 등 다른 시나리오는 통과했다. main의 gitGraph 단계도 통과했다.
  - main 시나리오는 화면 잠금(`CGSSessionScreenIsLocked`, `hasFocus=false`) 때문에 트리 화살표, 폰 채팅 스크롤, 배율, WebGL,
    검색 막대(×로 닫기)가 실패했다. 화면 잠금이 풀린 뒤 다시 돌려야 한다.
