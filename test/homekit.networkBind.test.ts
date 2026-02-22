import os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveHomekitBind, selectAutoBindInterface } from "../src/homekit/networkBind";

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:11:22:33:44:55",
    internal,
    cidr: `${address}/24`
  };
}

function ipv6(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:11:22:33:44:55",
    internal,
    cidr: `${address}/64`,
    scopeid: 0
  };
}

describe("selectAutoBindInterface", () => {
  it("prefers LAN interface over docker bridge", () => {
    const selected = selectAutoBindInterface({
      docker0: [ipv4("172.17.0.1")],
      eno1: [ipv4("192.168.1.10")]
    });

    expect(selected).toBe("eno1");
  });

  it("selects macOS-style en0 when available", () => {
    const selected = selectAutoBindInterface({
      lo0: [ipv4("127.0.0.1", true)],
      en0: [ipv4("10.0.0.20")],
      awdl0: [ipv6("fe80::1234")]
    });

    expect(selected).toBe("en0");
  });

  it("ignores VPN-like interfaces and chooses LAN NIC", () => {
    const selected = selectAutoBindInterface({
      utun2: [ipv4("10.44.0.5")],
      tailscale0: [ipv4("100.77.1.5")],
      en7: [ipv4("192.168.50.3")]
    });

    expect(selected).toBe("en7");
  });

  it("returns undefined when no suitable interface exists", () => {
    const selected = selectAutoBindInterface({
      lo: [ipv4("127.0.0.1", true)],
      docker0: [ipv4("172.17.0.1")],
      veth1234: [ipv4("169.254.2.3")],
      utun0: [ipv4("10.2.0.1")]
    });

    expect(selected).toBeUndefined();
  });
});

describe("resolveHomekitBind", () => {
  it("uses env-configured bind values when present", () => {
    const decision = resolveHomekitBind(["eno1", "en0"], true, {
      en0: [ipv4("192.168.1.10")]
    });

    expect(decision).toEqual({
      bind: ["eno1", "en0"],
      source: "env"
    });
  });

  it("auto-selects interface when enabled and bind list is empty", () => {
    const decision = resolveHomekitBind([], true, {
      docker0: [ipv4("172.17.0.1")],
      wlan0: [ipv4("192.168.10.9")]
    });

    expect(decision).toEqual({
      bind: ["wlan0"],
      source: "auto"
    });
  });

  it("returns none when auto-bind is disabled", () => {
    const decision = resolveHomekitBind([], false, {
      en0: [ipv4("192.168.1.10")]
    });

    expect(decision).toEqual({ source: "none" });
  });
});

