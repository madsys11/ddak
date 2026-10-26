import type { Message } from "./api";

// 채팅 화면이 보이는 메시지 (서버에는 재생이 없어서 화면이 맞춘다).
// - 처음 열 때, SSE가 다시 이어질 때, 대화를 지웠을 때는 최신 페이지로 통째로 바꾼다 (begin → latest). 끊긴 동안 생긴 것이
//   최신 50개보다 많거나 지워졌어도 서버와 같아진다 (리뷰 R3: 합치기만 하면 가운데가 빠지거나 지운 것이 남았다).
//   이전 페이지를 더 읽어 둔 것은 버린다.
// - 요청을 보낸 뒤 이벤트로 온 메시지는 응답에 없을 수 있어서 남긴다. 겹친 요청은 마지막 것만 쓴다 (리뷰 R2: 늦게 온 첫 응답을
//   버리며 more도 잃었다. 이제는 어느 요청이든 more를 함께 정한다).
// - 이전 페이지(earlier)는 최신 조회가 없을 때만 읽고, 그 요청 뒤에 최신 조회를 시작한 적이 없을 때만 앞에 붙인다 (아니면 사이가
//   빈다. 재리뷰 R3: 최신 조회를 기다리는 동안 읽은 이전 페이지가 새 목록에 붙었다).
export class MessageView {
  messages: Message[] = [];
  more = false;
  private load = 0;
  // 목록의 세대: 최신 조회를 시작하거나 적용할 때마다 오른다 (이전 페이지 응답이 그 사이 바뀐 목록에 붙지 않게)
  private gen = 0;
  private pending: Message[] | null = null;

  // 최신 페이지를 읽기 시작한다. 돌려준 번호를 latest에 넘긴다.
  begin() {
    this.pending = [];
    this.gen++;
    return ++this.load;
  }

  // SSE로 온 새 메시지
  event(m: Message) {
    this.messages = merge(this.messages, [m]);
    this.pending?.push(m);
  }

  // 최신 페이지 응답. 늦은 응답이면 false (쓰지 않음)
  latest(load: number, page: Message[], more: boolean) {
    if (load !== this.load) return false;
    this.messages = merge(page, this.pending ?? []);
    this.more = more;
    this.pending = null;
    this.gen++;
    return true;
  }

  // 최신 페이지 조회 실패. 마지막 조회일 때만 기다림을 푼다 (재리뷰 R6: 풀지 않으면 다음 조회가 성공할 때까지 이전 메시지를
  // 읽지 못했다). 목록은 그대로 두고 세대는 begin에서 이미 올라서 그 전에 보낸 이전 페이지 요청은 붙지 않는다.
  fail(load: number) {
    if (load === this.load) this.pending = null;
  }

  // 이전 페이지를 읽기 시작한다 (가장 오래된 번호와, earlier에 넘길 번호). 최신 조회를 기다리는 중이면 before가 없다.
  older() {
    return { before: this.pending ? undefined : this.messages[0]?.id, gen: this.gen };
  }

  earlier(gen: number, page: Message[], more: boolean) {
    if (gen !== this.gen) return false;
    this.messages = merge(page, this.messages);
    this.more = more;
    return true;
  }
}

// 번호로 합친다 (같은 번호는 뒤의 것)
function merge(a: Message[], b: Message[]) {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}
