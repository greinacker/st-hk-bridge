import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeCoordinator } from "../src/bridge/coordinator";
import type { LockStateSink } from "../src/homekit/lockAccessory";

class FakeAccessory implements LockStateSink {
  public state = "unknown" as "locked" | "unlocked" | "unknown";

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

describe("BridgeCoordinator", () => {
  const logger = pino({ level: "silent" });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps last known state during a transient polling failure", async () => {
    const accessory = new FakeAccessory();
    const getLockStatus = vi
      .fn<() => Promise<"locked" | "unlocked" | "unknown">>()
      .mockResolvedValueOnce("locked")
      .mockRejectedValueOnce(new Error("boom"));

    const coordinator = new BridgeCoordinator({
      client: {
        getLockStatus,
        sendLockCommand: vi.fn()
      },
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      logger
    });

    await coordinator.pollOnce();
    await expect(coordinator.pollOnce()).rejects.toThrow("boom");

    const state = coordinator.getBridgeState();
    expect(accessory.state).toBe("locked");
    expect(state.status).toBe("degraded");
    expect(state.currentMappedState).toBe("locked");
    expect(state.lastPollError).toContain("boom");
  });

  it("marks state unknown after consecutive failures hit threshold", async () => {
    const accessory = new FakeAccessory();
    accessory.updateFromLockState("locked");

    const getLockStatus = vi
      .fn<() => Promise<"locked" | "unlocked" | "unknown">>()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));

    const coordinator = new BridgeCoordinator({
      client: {
        getLockStatus,
        sendLockCommand: vi.fn()
      },
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      pollFailuresBeforeUnknown: 2,
      pollFailureGraceMs: 999_000,
      initialMappedState: "locked",
      logger
    });

    await expect(coordinator.pollOnce()).rejects.toThrow("first failure");
    expect(accessory.state).toBe("locked");

    await expect(coordinator.pollOnce()).rejects.toThrow("second failure");

    const state = coordinator.getBridgeState();
    expect(accessory.state).toBe("unknown");
    expect(state.status).toBe("degraded");
    expect(state.currentMappedState).toBe("unknown");
    expect(state.lastPollError).toContain("second failure");
  });

  it("recovers after failure and clears previous poll error", async () => {
    const accessory = new FakeAccessory();

    const getLockStatus = vi
      .fn<() => Promise<"locked" | "unlocked" | "unknown">>()
      .mockResolvedValueOnce("unlocked")
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("locked");

    const coordinator = new BridgeCoordinator({
      client: {
        getLockStatus,
        sendLockCommand: vi.fn()
      },
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      logger
    });

    await coordinator.pollOnce();
    await expect(coordinator.pollOnce()).rejects.toThrow("temporary failure");
    await coordinator.pollOnce();

    const state = coordinator.getBridgeState();
    expect(accessory.state).toBe("locked");
    expect(state.status).toBe("ok");
    expect(state.currentMappedState).toBe("locked");
    expect(state.lastPollError).toBeNull();
    expect(state.lastSuccessfulPollAt).not.toBeNull();
  });

  it("polls at burst interval for a limited window after command trigger", async () => {
    vi.useFakeTimers();

    const accessory = new FakeAccessory();
    const getLockStatus = vi.fn().mockResolvedValue("locked");

    const coordinator = new BridgeCoordinator({
      client: {
        getLockStatus,
        sendLockCommand: vi.fn()
      },
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      logger
    });

    coordinator.triggerCommandPollBurst("unlocked");
    await vi.runAllTicks();
    expect(getLockStatus).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getLockStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getLockStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getLockStatus).toHaveBeenCalledTimes(2);
  });

  it("ends burst polling early when observed state matches target", async () => {
    vi.useFakeTimers();

    const accessory = new FakeAccessory();
    const getLockStatus = vi
      .fn<() => Promise<"locked" | "unlocked" | "unknown">>()
      .mockResolvedValueOnce("locked")
      .mockResolvedValueOnce("locked");

    const coordinator = new BridgeCoordinator({
      client: {
        getLockStatus,
        sendLockCommand: vi.fn()
      },
      accessory,
      pollIntervalMs: 30_000,
      burstPollIntervalMs: 5_000,
      burstDurationMs: 15_000,
      logger
    });

    coordinator.triggerCommandPollBurst("locked");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getLockStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getLockStatus).toHaveBeenCalledTimes(1);
  });
});
