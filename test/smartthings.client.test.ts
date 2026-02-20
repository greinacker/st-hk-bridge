import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  SmartThingsApiError,
  SmartThingsClient,
  SmartThingsRequestTimeoutError,
  parseLockState,
  parseRetryAfterMs
} from "../src/smartthings/client";

describe("parseLockState", () => {
  it("maps locked and unlocked lock values", () => {
    expect(
      parseLockState({
        components: { main: { lock: { lock: { value: "locked" } } } }
      })
    ).toBe("locked");

    expect(
      parseLockState({
        components: { main: { lock: { lock: { value: "unlocked" } } } }
      })
    ).toBe("unlocked");
  });

  it("maps unknown values to unknown", () => {
    expect(parseLockState({ components: { main: { lock: { lock: { value: "jammed" } } } } })).toBe(
      "unknown"
    );
    expect(parseLockState({})).toBe("unknown");
  });
});

describe("parseRetryAfterMs", () => {
  it("supports seconds format", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("falls back when header is missing", () => {
    expect(parseRetryAfterMs(null)).toBe(1000);
  });
});

describe("SmartThingsClient", () => {
  const logger = pino({ level: "silent" });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends command payload for lock", async () => {
    const calls: RequestInit[] = [];

    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl: "https://example.test/v1",
      logger,
      fetchImpl: async (_input, init) => {
        calls.push(init ?? {});
        return new Response("{}", { status: 200 });
      }
    });

    await client.sendLockCommand("lock");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse((calls[0]?.body as string) ?? "{}")).toEqual({
      commands: [
        {
          component: "main",
          capability: "lock",
          command: "lock"
        }
      ]
    });
  });

  it("retries once for a 429 response", async () => {
    let requestCount = 0;

    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl: "https://example.test/v1",
      logger,
      fetchImpl: async () => {
        requestCount += 1;

        if (requestCount === 1) {
          return new Response("", {
            status: 429,
            headers: {
              "Retry-After": "0"
            }
          });
        }

        return new Response(
          JSON.stringify({
            components: {
              main: {
                lock: {
                  lock: {
                    value: "locked"
                  }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
    });

    const status = await client.getLockStatus();

    expect(status).toBe("locked");
    expect(requestCount).toBe(2);
  });

  it("throws SmartThingsApiError for unauthorized responses", async () => {
    const client = new SmartThingsClient({
      token: "bad-token",
      deviceId: "device-1",
      baseUrl: "https://example.test/v1",
      logger,
      fetchImpl: async () => new Response("unauthorized", { status: 401 })
    });

    await expect(client.getLockStatus()).rejects.toBeInstanceOf(SmartThingsApiError);

    try {
      await client.getLockStatus();
    } catch (error) {
      expect((error as SmartThingsApiError).status).toBe(401);
    }
  });

  it("times out SmartThings requests that exceed configured timeout", async () => {
    vi.useFakeTimers();

    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl: "https://example.test/v1",
      logger,
      requestTimeoutMs: 100,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
    });

    const statusPromise = expect(client.getLockStatus()).rejects.toBeInstanceOf(
      SmartThingsRequestTimeoutError
    );
    await vi.advanceTimersByTimeAsync(100);
    await statusPromise;
  });

  it("throttles requests to stay within configured per-minute budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          components: {
            main: {
              lock: {
                lock: {
                  value: "locked"
                }
              }
            }
          }
        }),
        { status: 200 }
      );
    });

    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl: "https://example.test/v1",
      logger,
      maxRequestsPerMinute: 1,
      fetchImpl
    });

    await client.getLockStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const secondRequest = client.getLockStatus();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await secondRequest;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
