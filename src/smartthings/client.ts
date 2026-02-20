import type { Logger } from "pino";
import type { LockState } from "../types";

export type LockCommandTarget = "lock" | "unlock";

type FetchLike = typeof globalThis.fetch;

type LoggerLike = Pick<Logger, "debug" | "warn">;

const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 10;
const ONE_MINUTE_MS = 60_000;

export interface SmartThingsClientLike {
  getLockStatus(): Promise<LockState>;
  sendLockCommand(target: LockCommandTarget): Promise<void>;
}

export interface SmartThingsClientOptions {
  token: string;
  deviceId: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
  logger: LoggerLike;
  requestTimeoutMs?: number;
  maxRequestsPerMinute?: number;
}

export class SmartThingsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly responseBody: string | null
  ) {
    super(message);
    this.name = "SmartThingsApiError";
  }
}

export class SmartThingsRequestTimeoutError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly timeoutMs: number
  ) {
    super(message);
    this.name = "SmartThingsRequestTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return DEFAULT_RETRY_DELAY_MS;
  }

  const asSeconds = Number(value);
  if (!Number.isNaN(asSeconds) && Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return DEFAULT_RETRY_DELAY_MS;
}

function parseLockState(payload: unknown): LockState {
  const value = (payload as { components?: { main?: { lock?: { lock?: { value?: unknown } } } } })
    ?.components?.main?.lock?.lock?.value;

  if (value === "locked" || value === "unlocked") {
    return value;
  }

  return "unknown";
}

export class SmartThingsClient implements SmartThingsClientLike {
  private readonly token: string;
  private readonly deviceId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: LoggerLike;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestsPerMinute: number;
  private readonly requestTimestampsMs: number[] = [];
  private rateLimitReservationChain: Promise<void> = Promise.resolve();

  constructor(options: SmartThingsClientOptions) {
    this.token = options.token;
    this.deviceId = options.deviceId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxRequestsPerMinute =
      options.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
  }

  async getLockStatus(): Promise<LockState> {
    const response = await this.requestWithRetry("GET", `/devices/${this.deviceId}/status`);
    const body = await response.json();
    return parseLockState(body);
  }

  async sendLockCommand(target: LockCommandTarget): Promise<void> {
    await this.requestWithRetry("POST", `/devices/${this.deviceId}/commands`, {
      commands: [
        {
          component: "main",
          capability: "lock",
          command: target
        }
      ]
    });
  }

  private async requestWithRetry(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<Response> {
    const response = await this.request(method, endpoint, body);

    if (response.status !== 429) {
      if (!response.ok) {
        throw await this.buildApiError(response, endpoint);
      }
      return response;
    }

    const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
    this.logger.warn(
      { endpoint, delayMs },
      "SmartThings rate limited request (429). Retrying once after delay."
    );

    await sleep(delayMs);

    const retryResponse = await this.request(method, endpoint, body);
    if (!retryResponse.ok) {
      throw await this.buildApiError(retryResponse, endpoint);
    }

    return retryResponse;
  }

  private async request(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<Response> {
    await this.reserveRateLimitSlot(endpoint);

    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json"
    };

    const init: RequestInit = {
      method,
      headers
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const timeoutController = new AbortController();
    init.signal = timeoutController.signal;

    const timeout = setTimeout(() => {
      timeoutController.abort();
    }, this.requestTimeoutMs);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }

    this.logger.debug({ method, url }, "Calling SmartThings API");
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new SmartThingsRequestTimeoutError(
          `SmartThings request timed out after ${this.requestTimeoutMs}ms.`,
          endpoint,
          this.requestTimeoutMs
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildApiError(response: Response, endpoint: string): Promise<SmartThingsApiError> {
    const text = await response.text().catch(() => "");
    const compactBody = text.length > 400 ? `${text.slice(0, 400)}...` : text;

    let message: string;
    if (response.status === 401) {
      message = "SmartThings rejected the token (401 Unauthorized).";
    } else if (response.status === 403) {
      message = "SmartThings denied access to this device (403 Forbidden).";
    } else if (response.status === 404) {
      message = "SmartThings device was not found (404).";
    } else if (response.status === 429) {
      message = "SmartThings request was rate limited after retry (429).";
    } else if (response.status >= 500) {
      message = `SmartThings server error (${response.status}).`;
    } else {
      message = `SmartThings request failed (${response.status}).`;
    }

    return new SmartThingsApiError(message, response.status, endpoint, compactBody || null);
  }

  private async reserveRateLimitSlot(endpoint: string): Promise<void> {
    const reservation = this.rateLimitReservationChain.then(async () => {
      while (true) {
        const now = Date.now();
        const windowStart = now - ONE_MINUTE_MS;

        while (
          this.requestTimestampsMs.length > 0 &&
          this.requestTimestampsMs[0] !== undefined &&
          this.requestTimestampsMs[0] <= windowStart
        ) {
          this.requestTimestampsMs.shift();
        }

        if (this.requestTimestampsMs.length < this.maxRequestsPerMinute) {
          this.requestTimestampsMs.push(now);
          return;
        }

        const oldestTimestamp = this.requestTimestampsMs[0];
        const waitMs = oldestTimestamp === undefined ? ONE_MINUTE_MS : oldestTimestamp + ONE_MINUTE_MS - now;

        this.logger.warn(
          {
            endpoint,
            waitMs,
            maxRequestsPerMinute: this.maxRequestsPerMinute
          },
          "Delaying SmartThings request to stay within request budget"
        );

        await sleep(Math.max(waitMs, 1));
      }
    });

    this.rateLimitReservationChain = reservation.catch(() => {
      // Keep the chain alive if a reservation attempt fails.
    });

    await reservation;
  }
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

export { parseLockState, parseRetryAfterMs };
