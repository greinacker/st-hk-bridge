import { z } from "zod";

const HOMEKIT_ADVERTISERS = ["ciao", "bonjour-hap", "avahi", "resolved"] as const;

export type HomekitAdvertiser = (typeof HOMEKIT_ADVERTISERS)[number];

function normalizeEnvString(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function toMilliseconds(seconds: number): number {
  return seconds * 1000;
}

const homekitAdvertiserSchema = z.preprocess(
  (value) => {
    const normalized = normalizeEnvString(value).toLowerCase();
    return normalized === "" ? "ciao" : normalized;
  },
  z
    .string()
    .refine(
      (value): value is HomekitAdvertiser =>
        HOMEKIT_ADVERTISERS.includes(value as HomekitAdvertiser),
      {
        message: "HOMEKIT_ADVERTISER must be one of ciao, bonjour-hap, avahi, resolved"
      }
    )
);

const homekitBindSchema = z.preprocess((value) => {
  const normalized = normalizeEnvString(value);
  if (normalized === "") {
    return [];
  }

  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}, z.array(z.string()));

const homekitAutoBindSchema = z.preprocess(
  (value) => {
    const normalized = normalizeEnvString(value).toLowerCase();
    return normalized === "" ? "true" : normalized;
  },
  z
    .string()
    .refine((value) => value === "true" || value === "false", {
      message: "HOMEKIT_AUTO_BIND must be true or false"
    })
    .transform((value) => value === "true")
);

const rawConfigSchema = z.object({
  SMARTTHINGS_TOKEN: z.string().min(1, "SMARTTHINGS_TOKEN is required"),
  SMARTTHINGS_DEVICE_ID: z.string().min(1, "SMARTTHINGS_DEVICE_ID is required"),
  HOMEKIT_BRIDGE_NAME: z.string().min(1, "HOMEKIT_BRIDGE_NAME is required"),
  HOMEKIT_USERNAME: z
    .string()
    .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, "HOMEKIT_USERNAME must match AA:BB:CC:DD:EE:FF")
    .transform((value) => value.toUpperCase()),
  HOMEKIT_SETUP_CODE: z
    .string()
    .regex(/^\d{3}-\d{2}-\d{3}$/, "HOMEKIT_SETUP_CODE must match 123-45-678"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  COMMAND_BURST_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  COMMAND_BURST_DURATION_SECONDS: z.coerce.number().int().min(1).max(600).default(15),
  TRANSITION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  POLL_FAILURES_BEFORE_UNKNOWN: z.coerce.number().int().min(1).max(20).default(3),
  POLL_FAILURE_GRACE_SECONDS: z.coerce.number().int().min(1).max(3600).default(90),
  SMARTTHINGS_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  SMARTTHINGS_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(60).default(10),
  SMARTTHINGS_API_BASE: z
    .string()
    .url("SMARTTHINGS_API_BASE must be a valid URL")
    .default("https://api.smartthings.com/v1")
    .transform((value) => value.replace(/\/+$/, "")),
  HOMEKIT_PORT: z.coerce.number().int().min(1).max(65535).default(51826),
  HOMEKIT_ADVERTISER: homekitAdvertiserSchema,
  HOMEKIT_BIND: homekitBindSchema,
  HOMEKIT_AUTO_BIND: homekitAutoBindSchema,
  DATA_DIR: z.string().min(1).default("/data"),
  LOG_LEVEL: z.string().min(1).default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080)
});

const configSchema = rawConfigSchema.transform((data): AppConfig => ({
  smartThingsToken: data.SMARTTHINGS_TOKEN,
  smartThingsDeviceId: data.SMARTTHINGS_DEVICE_ID,
  smartThingsApiBase: data.SMARTTHINGS_API_BASE,
  homeKitBridgeName: data.HOMEKIT_BRIDGE_NAME,
  homeKitUsername: data.HOMEKIT_USERNAME,
  homeKitSetupCode: data.HOMEKIT_SETUP_CODE,
  homeKitPort: data.HOMEKIT_PORT,
  homeKitAdvertiser: data.HOMEKIT_ADVERTISER,
  homeKitBind: data.HOMEKIT_BIND,
  homeKitAutoBind: data.HOMEKIT_AUTO_BIND,
  pollIntervalMs: toMilliseconds(data.POLL_INTERVAL_SECONDS),
  commandBurstPollIntervalMs: toMilliseconds(data.COMMAND_BURST_POLL_INTERVAL_SECONDS),
  commandBurstDurationMs: toMilliseconds(data.COMMAND_BURST_DURATION_SECONDS),
  transitionTimeoutMs: toMilliseconds(data.TRANSITION_TIMEOUT_SECONDS),
  pollFailuresBeforeUnknown: data.POLL_FAILURES_BEFORE_UNKNOWN,
  pollFailureGraceMs: toMilliseconds(data.POLL_FAILURE_GRACE_SECONDS),
  smartThingsRequestTimeoutMs: toMilliseconds(data.SMARTTHINGS_REQUEST_TIMEOUT_SECONDS),
  smartThingsMaxRequestsPerMinute: data.SMARTTHINGS_MAX_REQUESTS_PER_MINUTE,
  dataDir: data.DATA_DIR,
  logLevel: data.LOG_LEVEL,
  healthPort: data.HEALTH_PORT
}));

export interface AppConfig {
  smartThingsToken: string;
  smartThingsDeviceId: string;
  smartThingsApiBase: string;
  homeKitBridgeName: string;
  homeKitUsername: string;
  homeKitSetupCode: string;
  homeKitPort: number;
  homeKitAdvertiser: HomekitAdvertiser;
  homeKitBind: string[];
  homeKitAutoBind: boolean;
  pollIntervalMs: number;
  commandBurstPollIntervalMs: number;
  commandBurstDurationMs: number;
  transitionTimeoutMs: number;
  pollFailuresBeforeUnknown: number;
  pollFailureGraceMs: number;
  smartThingsRequestTimeoutMs: number;
  smartThingsMaxRequestsPerMinute: number;
  dataDir: string;
  logLevel: string;
  healthPort: number;
}

function formatZodErrors(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${formatZodErrors(parsed.error)}`);
  }

  return parsed.data;
}
