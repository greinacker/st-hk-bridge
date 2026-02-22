import os from "node:os";

const excludedInterfacePatterns = [
  /^lo$/,
  /^docker\d*$/,
  /^br-/,
  /^veth/,
  /^virbr/,
  /^vmnet/,
  /^utun/,
  /^tailscale/,
  /^wg/,
  /^tun/
];

const preferredInterfacePatterns = [/^en\d*/i, /^eth\d*/i, /^eno\d*/i, /^enp\d*/i, /^wlan\d*/i, /^wl/i];

export type HomekitBindSource = "env" | "auto" | "none";

export interface HomekitBindDecision {
  bind?: string[];
  source: HomekitBindSource;
}

function isExcludedInterface(name: string): boolean {
  return excludedInterfacePatterns.some((pattern) => pattern.test(name));
}

function isPreferredInterface(name: string): boolean {
  return preferredInterfacePatterns.some((pattern) => pattern.test(name));
}

function isLinkLocal(address: string): boolean {
  const lower = address.toLowerCase();
  return lower.startsWith("169.254.") || lower.startsWith("fe80:");
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  if (octets[0] === 10) {
    return true;
  }

  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return true;
  }

  return octets[0] === 192 && octets[1] === 168;
}

function isIpv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

export function selectAutoBindInterface(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | undefined {
  const candidates: Array<{
    name: string;
    hasPrivateIpv4: boolean;
    preferredName: boolean;
  }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || isExcludedInterface(name)) {
      continue;
    }

    const routableEntries = entries.filter((entry) => !entry.internal && !isLinkLocal(entry.address));
    if (routableEntries.length === 0) {
      continue;
    }

    candidates.push({
      name,
      hasPrivateIpv4: routableEntries.some(
        (entry) => isIpv4Family(entry.family) && isPrivateIpv4(entry.address)
      ),
      preferredName: isPreferredInterface(name)
    });
  }

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((a, b) => {
    if (a.hasPrivateIpv4 !== b.hasPrivateIpv4) {
      return a.hasPrivateIpv4 ? -1 : 1;
    }
    if (a.preferredName !== b.preferredName) {
      return a.preferredName ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return candidates[0].name;
}

export function resolveHomekitBind(
  configuredBind: string[],
  autoBindEnabled: boolean,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): HomekitBindDecision {
  if (configuredBind.length > 0) {
    return {
      bind: configuredBind,
      source: "env"
    };
  }

  if (!autoBindEnabled) {
    return { source: "none" };
  }

  const selectedInterface = selectAutoBindInterface(interfaces);
  if (!selectedInterface) {
    return { source: "none" };
  }

  return {
    bind: [selectedInterface],
    source: "auto"
  };
}

