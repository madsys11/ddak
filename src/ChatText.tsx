import { splitUrls } from "./urls";

// 채팅 글: 웹 주소는 누르면 열리는 링크로 (src/urls.ts). 맥 채팅 패널은 onOpen(기본 브라우저, links.rs open_link)으로,
// 폰은 새 탭으로 연다 (onOpen 없음). 나머지 글은 그대로
export function ChatText({ text, onOpen }: { text: string; onOpen?: (url: string) => void }) {
  return (
    <>
      {splitUrls(text).map((part, i) =>
        part.url === undefined ? (
          part.text
        ) : onOpen ? (
          <a
            key={i}
            href={part.url}
            onClick={(e) => {
              e.preventDefault();
              onOpen(part.url!);
            }}
          >
            {part.text}
          </a>
        ) : (
          <a key={i} href={part.url} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ),
      )}
    </>
  );
}
