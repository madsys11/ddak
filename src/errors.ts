// Rust 명령이 돌려주는 { code, detail } 오류 (src-tauri/src/fs.rs의 CodeError).
// 코드가 아닌 오류(문자열 등)는 code를 비우고 원문을 detail에 담는다.
export type CodeError = { code: string; detail: string };

export const codeError = (raw: unknown): CodeError =>
  typeof raw === "object" && raw !== null && "code" in raw ? (raw as CodeError) : { code: "", detail: String(raw) };
