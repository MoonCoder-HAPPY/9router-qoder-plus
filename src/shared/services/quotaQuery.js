// Bound both the worker count and each consumer's wait, including proxy resolution.
export async function queryQuotaAccounts(items, query, onAccount, { signal, concurrency = 3, timeoutMs = 10000 } = {}) {
  let cursor = 0;
  async function worker() {
    while (!signal?.aborted && cursor < items.length) {
      const item = items[cursor++];
      const controller = new AbortController();
      let timer;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const stopped = new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason || new Error("Quota query cancelled")), { once: true });
          timer = setTimeout(() => controller.abort(new Error("Quota query timed out")), timeoutMs);
        });
        const result = await Promise.race([query(item, controller.signal), stopped]);
        if (!signal?.aborted) onAccount(item, result);
      } catch (error) {
        if (!signal?.aborted) onAccount(item, {
          remainingQuota: null, quotaRows: [], quotaStatus: "unavailable", quotaMessage: error.message,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

export function quotaEventResponse(run, signal) {
  const abortController = new AbortController();
  let closed = false;
  let streamController;
  const encoder = new TextEncoder();
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    streamController?.close();
  };
  const abort = () => { abortController.abort(); close(); };
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const emit = (event) => {
        if (!closed && !abortController.signal.aborted) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      };
      Promise.resolve().then(() => run(emit, abortController.signal))
        .catch(() => emit({ type: "error", error: "Failed to load quota options" }))
        .finally(close);
    },
    cancel() {
      closed = true;
      signal?.removeEventListener("abort", abort);
      abortController.abort();
    },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
  } });
}
