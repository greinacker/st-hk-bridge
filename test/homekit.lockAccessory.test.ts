import { Characteristic, HAPStatus, HapStatusError } from "hap-nodejs";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LockAccessory,
  mapDesiredLockStateToTargetCharacteristicValue,
  mapLockStateToCurrentCharacteristicValue
} from "../src/homekit/lockAccessory";
import type { LockCommandTarget } from "../src/smartthings/client";

const logger = pino({ level: "silent" });

function createAccessory(
  commandHandler: (target: LockCommandTarget) => Promise<void>,
  options?: { transitionTimeoutMs?: number }
): LockAccessory {
  return new LockAccessory({
    bridgeName: "Front Door Lock",
    homekitUsername: "AA:BB:CC:DD:EE:FF",
    homekitSetupCode: "123-45-678",
    homekitPort: 51826,
    transitionTimeoutMs: options?.transitionTimeoutMs,
    deviceId: "device-1",
    logger,
    commandHandler
  });
}

describe("LockAccessory mapping", () => {
  it("maps lock states to HomeKit current state values", () => {
    expect(mapLockStateToCurrentCharacteristicValue("locked")).toBe(
      Characteristic.LockCurrentState.SECURED
    );
    expect(mapLockStateToCurrentCharacteristicValue("unlocked")).toBe(
      Characteristic.LockCurrentState.UNSECURED
    );
    expect(mapLockStateToCurrentCharacteristicValue("unknown")).toBe(
      Characteristic.LockCurrentState.UNKNOWN
    );
  });

  it("maps desired states to HomeKit target values", () => {
    expect(mapDesiredLockStateToTargetCharacteristicValue("locked")).toBe(
      Characteristic.LockTargetState.SECURED
    );
    expect(mapDesiredLockStateToTargetCharacteristicValue("unlocked")).toBe(
      Characteristic.LockTargetState.UNSECURED
    );
  });
});

describe("LockAccessory command behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses confirm-only flow for commands", async () => {
    const commands: LockCommandTarget[] = [];
    const accessory = createAccessory(async (target) => {
      commands.push(target);
    });

    accessory.updateFromLockState("locked");

    await accessory.requestTargetState("unlocked");

    expect(commands).toEqual(["unlock"]);
    expect(accessory.getCurrentMappedState()).toBe("locked");
    expect(accessory.getTargetState()).toBe("unlocked");
  });

  it("prevents concurrent commands with a mutex", async () => {
    let resolvePending: (() => void) | null = null;

    const accessory = createAccessory(
      () =>
        new Promise<void>((resolve) => {
          resolvePending = resolve;
        })
    );

    const first = accessory.requestTargetState("unlocked");
    const second = accessory.requestTargetState("locked");

    await expect(second).rejects.toBeInstanceOf(HapStatusError);

    try {
      await second;
    } catch (error) {
      expect((error as HapStatusError).hapStatus).toBe(HAPStatus.RESOURCE_BUSY);
    }

    resolvePending?.();
    await first;
  });

  it("reports command transport errors as HomeKit communication failures", async () => {
    const accessory = createAccessory(async () => {
      throw new Error("network down");
    });

    await expect(accessory.requestTargetState("locked")).rejects.toBeInstanceOf(HapStatusError);

    try {
      await accessory.requestTargetState("locked");
    } catch (error) {
      expect((error as HapStatusError).hapStatus).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  });

  it("keeps target state during transition when stale poll state is returned", async () => {
    const accessory = createAccessory(async () => {});

    accessory.updateFromLockState("unlocked");
    await accessory.requestTargetState("locked");

    accessory.updateFromLockState("unlocked");

    expect(accessory.getCurrentMappedState()).toBe("unlocked");
    expect(accessory.getTargetState()).toBe("locked");
  });

  it("resumes target sync after expected state is observed", async () => {
    const accessory = createAccessory(async () => {});

    accessory.updateFromLockState("unlocked");
    await accessory.requestTargetState("locked");

    accessory.updateFromLockState("locked");
    expect(accessory.getTargetState()).toBe("locked");

    accessory.updateFromLockState("unlocked");
    expect(accessory.getTargetState()).toBe("unlocked");
  });

  it("clears pending transition after timeout when target state is never observed", async () => {
    vi.useFakeTimers();

    const accessory = createAccessory(async () => {}, { transitionTimeoutMs: 30_000 });

    accessory.updateFromLockState("unlocked");
    await accessory.requestTargetState("locked");
    expect(accessory.getTargetState()).toBe("locked");

    accessory.updateFromLockState("unlocked");
    expect(accessory.getTargetState()).toBe("locked");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(accessory.getTargetState()).toBe("unlocked");
  });
});
