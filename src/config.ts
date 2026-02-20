import { z } from "zod";

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
  SMARTTHINGS_API_BASE: z
    .string()
    .url("SMARTTHINGS_API_BASE must be a valid URL")
    .default("https://api.smartthings.com/v1")
    .transform((value) => value.replace(/\/+$/, "")),
  HOMEKIT_PORT: z.coerce.number().int().min(1).max(65535).default(51826),
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
  pollIntervalMs: number;
  commandBurstPollIntervalMs: number;
  commandBurstDurationMs: number;
  transitionTimeoutMs: number;
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
    pollIntervalMs: parsed.data.POLL_INTERVAL_SECONDS * 1000,
    commandBurstPollIntervalMs: parsed.data.COMMAND_BURST_POLL_INTERVAL_SECONDS * 1000,
    commandBurstDurationMs: parsed.data.COMMAND_BURST_DURATION_SECONDS * 1000,
    transitionTimeoutMs: parsed.data.TRANSITION_TIMEOUT_SECONDS * 1000,
    dataDir: parsed.data.DATA_DIR,
    logLevel: parsed.data.LOG_LEVEL,
    healthPort: parsed.data.HEALTH_PORT
  };
}
