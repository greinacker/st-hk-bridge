import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const validEnv: NodeJS.ProcessEnv = {
  SMARTTHINGS_TOKEN: "test-token",
  SMARTTHINGS_DEVICE_ID: "device-123",
  HOMEKIT_BRIDGE_NAME: "Front Door",
  HOMEKIT_USERNAME: "aa:bb:cc:dd:ee:ff",
  HOMEKIT_SETUP_CODE: "123-45-678"
};

describe("loadConfig", () => {
  it("loads valid config and applies defaults", () => {
    const config = loadConfig(validEnv);

    expect(config.smartThingsToken).toBe("test-token");
    expect(config.smartThingsDeviceId).toBe("device-123");
    expect(config.homeKitUsername).toBe("AA:BB:CC:DD:EE:FF");
    expect(config.pollIntervalMs).toBe(30000);
    expect(config.commandBurstPollIntervalMs).toBe(5000);
    expect(config.commandBurstDurationMs).toBe(15000);
    expect(config.transitionTimeoutMs).toBe(30000);
    expect(config.pollFailuresBeforeUnknown).toBe(3);
    expect(config.pollFailureGraceMs).toBe(90000);
    expect(config.smartThingsRequestTimeoutMs).toBe(15000);
    expect(config.smartThingsMaxRequestsPerMinute).toBe(10);
    expect(config.smartThingsApiBase).toBe("https://api.smartthings.com/v1");
    expect(config.homeKitPort).toBe(51826);
    expect(config.homeKitAdvertiser).toBe("ciao");
    expect(config.homeKitBind).toEqual([]);
    expect(config.homeKitAutoBind).toBe(true);
    expect(config.healthPort).toBe(8080);
  });

  it("fails on missing required values", () => {
    expect(() => {
      loadConfig({ ...validEnv, SMARTTHINGS_TOKEN: "" });
    }).toThrow(/SMARTTHINGS_TOKEN/);
  });

  it("fails for invalid HomeKit username", () => {
    expect(() => {
      loadConfig({ ...validEnv, HOMEKIT_USERNAME: "invalid" });
    }).toThrow(/HOMEKIT_USERNAME/);
  });

  it("fails for invalid HomeKit setup code", () => {
    expect(() => {
      loadConfig({ ...validEnv, HOMEKIT_SETUP_CODE: "12345678" });
    }).toThrow(/HOMEKIT_SETUP_CODE/);
  });

  it("fails for invalid poll failure threshold", () => {
    expect(() => {
      loadConfig({ ...validEnv, POLL_FAILURES_BEFORE_UNKNOWN: "0" });
    }).toThrow(/POLL_FAILURES_BEFORE_UNKNOWN/);
  });

  it("parses homekit advertiser, bind list, and auto-bind", () => {
    const config = loadConfig({
      ...validEnv,
      HOMEKIT_ADVERTISER: "avahi",
      HOMEKIT_BIND: "eno1, en0",
      HOMEKIT_AUTO_BIND: "false"
    });

    expect(config.homeKitAdvertiser).toBe("avahi");
    expect(config.homeKitBind).toEqual(["eno1", "en0"]);
    expect(config.homeKitAutoBind).toBe(false);
  });

  it("fails for invalid homekit advertiser", () => {
    expect(() => {
      loadConfig({ ...validEnv, HOMEKIT_ADVERTISER: "bad-option" });
    }).toThrow(/HOMEKIT_ADVERTISER/);
  });

  it("fails for invalid homekit auto-bind value", () => {
    expect(() => {
      loadConfig({ ...validEnv, HOMEKIT_AUTO_BIND: "yes" });
    }).toThrow(/HOMEKIT_AUTO_BIND/);
  });
});
