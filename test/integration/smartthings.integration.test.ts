import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeCoordinator } from "../../src/bridge/coordinator";
import type { LockStateSink } from "../../src/homekit/lockAccessory";
import { SmartThingsClient } from "../../src/smartthings/client";

class FakeAccessory implements LockStateSink {
  public state: "locked" | "unlocked" | "unknown" = "unknown";

  updateFromLockState(state: "locked" | "unlocked" | "unknown"): void {
    this.state = state;
  }

  setUnknownState(): void {
    this.state = "unknown";
  }

  getCurrentMappedState(): "locked" | "unlocked" | "unknown" {
    return this.state;
  }
}

interface MutableServerState {
  lockValue: "locked" | "unlocked";
  failNextStatusRequest: boolean;
  rateLimitOnce: boolean;
  receivedCommandBodies: unknown[];
}

function createHandler(state: MutableServerState) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? "";

    if (request.method === "GET" && url === "/v1/devices/device-1/status") {
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        response.writeHead(429, { "Retry-After": "0" });
        response.end();
        return;
      }

      if (state.failNextStatusRequest) {
        state.failNextStatusRequest = false;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "temporary failure" }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          components: {
            main: {
              lock: {
                lock: {
                  value: state.lockValue
                }
              }
            }
          }
        })
      );
      return;
    }

    if (request.method === "POST" && url === "/v1/devices/device-1/commands") {
      const chunks: Buffer[] = [];

      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        state.receivedCommandBodies.push(parsed);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  };
}

describe("SmartThings integration", () => {
  const logger = pino({ level: "silent" });

  let serverState: MutableServerState;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    serverState = {
      lockValue: "locked",
      failNextStatusRequest: false,
      rateLimitOnce: false,
      receivedCommandBodies: []
    };

    server = createServer(createHandler(serverState));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("sends correct SmartThings command payloads", async () => {
    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl,
      logger
    });

    await client.sendLockCommand("unlock");

    expect(serverState.receivedCommandBodies).toEqual([
      {
        commands: [
          {
            component: "main",
            capability: "lock",
            command: "unlock"
          }
        ]
      }
    ]);
  });

  it("updates bridge state from polled status and recovers after failure", async () => {
    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl,
      logger
    });

    const accessory = new FakeAccessory();
    const coordinator = new BridgeCoordinator({
      client,
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      logger
    });

    serverState.lockValue = "unlocked";
    await coordinator.pollOnce();
    expect(accessory.state).toBe("unlocked");

    serverState.failNextStatusRequest = true;
    await expect(coordinator.pollOnce()).rejects.toThrow();
    expect(accessory.state).toBe("unlocked");
    expect(coordinator.getBridgeState().status).toBe("degraded");

    serverState.lockValue = "locked";
    await coordinator.pollOnce();

    const state = coordinator.getBridgeState();
    expect(accessory.state).toBe("locked");
    expect(state.lastPollError).toBeNull();
    expect(state.status).toBe("ok");
  });

  it("retries once after a 429 response", async () => {
    const client = new SmartThingsClient({
      token: "token",
      deviceId: "device-1",
      baseUrl,
      logger
    });

    serverState.rateLimitOnce = true;
    serverState.lockValue = "locked";

    await expect(client.getLockStatus()).resolves.toBe("locked");
  });
});
