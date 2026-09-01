/**
 * Parse a fetch() body as newline-delimited JSON.
 *
 * Lichess sends bare "\n" lines as keep-alives; those are skipped. The stream
 * ends when the server closes it (game over) or the abort signal fires.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {object} [opts]
 * @param {() => void} [opts.onActivity] Called for every chunk received,
 *        including keep-alives. Lets callers detect a silently dead socket.
 * @yields {object}
 */
export async function* readNdjson(body, { onActivity } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
      newline = buffer.indexOf('\n');
    }
  }

  const tail = (buffer + decoder.decode()).trim();
  if (tail) yield JSON.parse(tail);
}
