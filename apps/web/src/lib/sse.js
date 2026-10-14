/**
 * Read a server-sent-events response and call `onFrame(object)` for each `data:` frame.
 * Comment lines (the server's keep-alives) are ignored. Resolves when the stream ends.
 */
export async function readSse(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!raw.startsWith("data: ")) continue;
      try {
        onFrame(JSON.parse(raw.slice(6)));
      } catch {
        /* a malformed frame is skipped, not fatal */
      }
    }
  }
}
