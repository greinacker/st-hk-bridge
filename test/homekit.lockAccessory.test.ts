import { Accessory, Characteristic, HAPStatus, HapStatusError } from "hap-nodejs";
import os from "node:os";
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
  options?: {
    transitionTimeoutMs?: number;
    homekitAdvertiser?: "ciao" | "bonjour-hap" | "avahi" | "resolved";
    homekitBind?: string[];
    homekitAutoBind?: boolean;
  }
): LockAccessory {
  return new LockAccessory({
    bridgeName: "Front Door Lock",
    homekitUsername: "AA:BB:CC:DD:EE:FF",
    homekitSetupCode: "123-45-678",
    homekitPort: 51826,
    homekitAdvertiser: options?.homekitAdvertiser ?? "ciao",
    homekitBind: options?.homekitBind ?? [],
    homekitAutoBind: options?.homekitAutoBind ?? true,
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
    vi.restoreAllMocks();
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

  it("passes advertiser and explicit bind to publish", async () => {
    const publishSpy = vi.spyOn(Accessory.prototype, "publish").mockResolvedValue(undefined);
    const accessory = createAccessory(async () => {}, {
      homekitAdvertiser: "bonjour-hap",
      homekitBind: ["eno1"],
      homekitAutoBind: true
    });

    await accessory.publish();

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const publishInfo = publishSpy.mock.calls[0]?.[0];
    expect(publishInfo.advertiser).toBe("bonjour-hap");
    expect(publishInfo.bind).toEqual(["eno1"]);
  });

  it("uses auto-selected bind interface during publish when bind is empty", async () => {
    const publishSpy = vi.spyOn(Accessory.prototype, "publish").mockResolvedValue(undefined);
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      docker0: [
        {
          address: "172.17.0.1",
          netmask: "255.255.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "172.17.0.1/16"
        }
      ],
      eno1: [
        {
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:11:22:33:44:55",
          internal: false,
          cidr: "192.168.1.10/24"
        }
      ]
    });

    const accessory = createAccessory(async () => {}, {
      homekitBind: [],
      homekitAutoBind: true
    });

    await accessory.publish();

    const publishInfo = publishSpy.mock.calls[0]?.[0];
    expect(publishInfo.bind).toEqual(["eno1"]);
  });

  it("omits bind when auto-bind is disabled and bind is empty", async () => {
    const publishSpy = vi.spyOn(Accessory.prototype, "publish").mockResolvedValue(undefined);
    const accessory = createAccessory(async () => {}, {
      homekitBind: [],
      homekitAutoBind: false
    });

    await accessory.publish();

    const publishInfo = publishSpy.mock.calls[0]?.[0];
    expect(publishInfo.bind).toBeUndefined();
  });
});
