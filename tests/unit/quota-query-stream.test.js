import { expect, it } from "vitest";
import { queryQuotaAccounts, quotaEventResponse } from "@/shared/services/quotaQuery.js";
import { readQuotaEvents } from "@/shared/services/quotaStreamClient.js";

it("limits concurrency, times out blocked rows and completes other rows", async () => {
  const started = [], results = [];
  const run = queryQuotaAccounts([1, 2, 3, 4], async id => {
    started.push(id);
    if (id < 4) return new Promise(() => {});
    return { quotaStatus: "ok" };
  }, (id, result) => results.push([id, result.quotaStatus]), { timeoutMs: 20 });
  expect(started).toEqual([1, 2, 3]);
  await run;
  expect(results).toContainEqual([1, "unavailable"]);
  expect(results).toContainEqual([4, "ok"]);
});
it("cancellation stops queued queries and releases the stream without enqueueing after close", async () => {
  const started = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const response = quotaEventResponse(async (emit, signal) => {
    emit({ type: "snapshot" });
    await queryQuotaAccounts([1, 2, 3, 4], async id => {
      started.push(id);
      return new Promise(() => {});
    }, () => emit({ type: "account" }), { signal });
    finish();
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await done;
  expect(started).toEqual([1, 2, 3]);
});
it("decodes split UTF-8 and SSE boundaries and rejects incomplete streams", async () => {
  const bytes = new TextEncoder().encode('event: snapshot\ndata: {"type":"snapshot","name":"账号"}\n\nevent: complete\ndata: {"type":"complete"}\n\n');
  const events = [];
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  await readQuotaEvents(new Response(stream), event => events.push(event));
  expect(events).toEqual([{ type: "snapshot", name: "账号" }, { type: "complete" }]);
  await expect(readQuotaEvents(new Response('data: {"type":"snapshot"}\n\n'), () => {})).rejects.toThrow("Quota stream interrupted");
});
it("ignores late frames after client cancellation and surfaces connection errors", async () => {
  const controller = new AbortController();
  let received = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(target) {
      controller.abort();
      target.enqueue(new TextEncoder().encode('data: {"type":"snapshot"}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  await readQuotaEvents(new Response(stream), () => received++, controller.signal);
  expect(received).toBe(0);
  expect(cancelled).toBe(true);
  await expect(readQuotaEvents(new Response('data: {"type":"error","error":"offline"}\n\n'), () => {}))
    .rejects.toThrow("offline");
});
