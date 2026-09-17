export async function readQuotaEvents(response, onEvent, signal) {
  if (!response.ok) throw new Error("Failed to load quota options");
  if (!response.body) throw new Error("Quota stream interrupted");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "error") throw new Error(event.error || "Failed to load quota options");
        if (signal?.aborted) return;
        onEvent(event);
        if (event.type === "complete") { complete = true; return; }
      }
      if (done) break;
    }
    if (!complete && !signal?.aborted) throw new Error("Quota stream interrupted");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
