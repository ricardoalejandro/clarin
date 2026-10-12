import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerPool } from "../workers";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}

describe("subset worker active and idle deadlines", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("allows cold startup longer than idle TTL, then releases an idle worker after one second", async () => {
    const pool = WorkerPool.create<string, string>(new URL("https://clarin.test/subset-worker.js"));
    const result = pool.postMessage("font", {});
    await vi.advanceTimersByTimeAsync(1500);
    const worker = FakeWorker.instances[0];
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.onmessage!({ data: "subset" });
    await expect(result).resolves.toBe("subset");
    await vi.advanceTimersByTimeAsync(999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("bounds a non-responsive active job at fifteen seconds", async () => {
    const pool = WorkerPool.create<string, string>(new URL("https://clarin.test/subset-worker.js"));
    const failure = pool.postMessage("font", {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(14999);
    expect(FakeWorker.instances[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await failure).message).toContain("15000ms");
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
  it("cancels the previous idle deadline when reusing the worker", async () => {
    const pool = WorkerPool.create<string, string>(new URL("https://clarin.test/subset-worker.js"));
    const first = pool.postMessage("first", {});
    await vi.advanceTimersByTimeAsync(0);
    FakeWorker.instances[0].onmessage!({ data: "first" });
    await first;
    await vi.advanceTimersByTimeAsync(900);
    const second = pool.postMessage("second", {});
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminate).not.toHaveBeenCalled();
    FakeWorker.instances[0].onmessage!({ data: "second" });
    await second;
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
});
