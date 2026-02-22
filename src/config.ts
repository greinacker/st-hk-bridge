import { z } from "zod";

export type HomekitAdvertiser = "ciao" | "bonjour-hap" | "avahi" | "resolved";

function parseHomekitAutoBind(value: unknown): boolean {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    return true;
  }

  const normalized = `${value}`.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error("HOMEKIT_AUTO_BIND must be true or false");
}

function parseHomekitBind(value: unknown): string[] {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    return [];
  }

  return `${value}`
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseHomekitAdvertiser(value: unknown): HomekitAdvertiser {
  const raw = value === undefined || value === null || `${value}`.trim() === "" ? "ciao" : `${value}`;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "ciao" ||
    normalized === "bonjour-hap" ||
    normalized === "avahi" ||
    normalized === "resolved"
  ) {
    return normalized;
  }

  throw new Error("HOMEKIT_ADVERTISER must be one of ciao, bonjour-hap, avahi, resolved");
}

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
  HOMEKIT_ADVERTISER: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseHomekitAdvertiser(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: (error as Error).message
        });
        return z.NEVER;
      }
    }),
  HOMEKIT_BIND: z
    .unknown()
    .optional()
    .transform((value) => parseHomekitBind(value)),
  HOMEKIT_AUTO_BIND: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      try {
        return parseHomekitAutoBind(value);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: (error as Error).message
        });
        return z.NEVER;
      }
    }),
  DATA_DIR: z.string().min(1).default("/data"),
  LOG_LEVEL: z.string().min(1).default("info"),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080)
});

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
  const parsed = rawConfigSchema.safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${formatZodErrors(parsed.error)}`);
  }

  return {
    smartThingsToken: parsed.data.SMARTTHINGS_TOKEN,
    smartThingsDeviceId: parsed.data.SMARTTHINGS_DEVICE_ID,
    smartThingsApiBase: parsed.data.SMARTTHINGS_API_BASE,
    homeKitBridgeName: parsed.data.HOMEKIT_BRIDGE_NAME,
    homeKitUsername: parsed.data.HOMEKIT_USERNAME,
    homeKitSetupCode: parsed.data.HOMEKIT_SETUP_CODE,
    homeKitPort: parsed.data.HOMEKIT_PORT,
    homeKitAdvertiser: parsed.data.HOMEKIT_ADVERTISER,
    homeKitBind: parsed.data.HOMEKIT_BIND,
    homeKitAutoBind: parsed.data.HOMEKIT_AUTO_BIND,
    pollIntervalMs: parsed.data.POLL_INTERVAL_SECONDS * 1000,
    commandBurstPollIntervalMs: parsed.data.COMMAND_BURST_POLL_INTERVAL_SECONDS * 1000,
    commandBurstDurationMs: parsed.data.COMMAND_BURST_DURATION_SECONDS * 1000,
    transitionTimeoutMs: parsed.data.TRANSITION_TIMEOUT_SECONDS * 1000,
    pollFailuresBeforeUnknown: parsed.data.POLL_FAILURES_BEFORE_UNKNOWN,
    pollFailureGraceMs: parsed.data.POLL_FAILURE_GRACE_SECONDS * 1000,
    smartThingsRequestTimeoutMs: parsed.data.SMARTTHINGS_REQUEST_TIMEOUT_SECONDS * 1000,
    smartThingsMaxRequestsPerMinute: parsed.data.SMARTTHINGS_MAX_REQUESTS_PER_MINUTE,
    dataDir: parsed.data.DATA_DIR,
    logLevel: parsed.data.LOG_LEVEL,
    healthPort: parsed.data.HEALTH_PORT
  };
}
