import { mkdir } from "node:fs/promises";
import { HAPStorage } from "hap-nodejs";
import { BridgeCoordinator } from "./bridge/coordinator";
import { loadConfig } from "./config";
import { HealthServer } from "./health/server";
import { LockAccessory } from "./homekit/lockAccessory";
import { createLogger } from "./logger";
import { SmartThingsClient } from "./smartthings/client";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  await mkdir(config.dataDir, { recursive: true });
  HAPStorage.setCustomStoragePath(config.dataDir);

  const smartThingsClient = new SmartThingsClient({
    token: config.smartThingsToken,
    deviceId: config.smartThingsDeviceId,
    baseUrl: config.smartThingsApiBase,
    logger
  });

  let coordinator: BridgeCoordinator | null = null;

  const accessory = new LockAccessory({
    bridgeName: config.homeKitBridgeName,
    homekitUsername: config.homeKitUsername,
    homekitSetupCode: config.homeKitSetupCode,
    homekitPort: config.homeKitPort,
    transitionTimeoutMs: config.transitionTimeoutMs,
    deviceId: config.smartThingsDeviceId,
    logger,
    commandHandler: async (target) => {
      await smartThingsClient.sendLockCommand(target);
      coordinator?.triggerCommandPollBurst(target === "lock" ? "locked" : "unlocked");
    }
  });

  coordinator = new BridgeCoordinator({
    client: smartThingsClient,
    accessory,
    pollIntervalMs: config.pollIntervalMs,
    burstPollIntervalMs: config.commandBurstPollIntervalMs,
    burstDurationMs: config.commandBurstDurationMs,
    logger
  });

  const healthServer = new HealthServer({
    port: config.healthPort,
    logger,
    getBridgeState: () => coordinator.getBridgeState()
  });

  try {
    await coordinator.pollOnce();
  } catch (error) {
    logger.warn({ error }, "Initial SmartThings poll failed. HomeKit state is set to Unknown.");
  }

  await accessory.publish();
  coordinator.start();
  await healthServer.start();

  logger.info(
    {
      pollIntervalMs: config.pollIntervalMs,
      commandBurstPollIntervalMs: config.commandBurstPollIntervalMs,
      commandBurstDurationMs: config.commandBurstDurationMs,
      transitionTimeoutMs: config.transitionTimeoutMs,
      healthPort: config.healthPort
    },
    "SmartThings-to-HomeKit lock bridge started"
  );

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({ signal }, "Shutting down lock bridge");

    coordinator.stop();

    await healthServer.stop().catch((error: unknown) => {
      logger.warn({ error }, "Failed to stop health server cleanly");
    });

    await accessory.unpublish().catch((error: unknown) => {
      logger.warn({ error }, "Failed to unpublish HomeKit accessory cleanly");
    });

    if (typeof logger.flush === "function") {
      logger.flush();
    }

    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error) => {
  // Fallback logging before logger is initialized or if startup crashes.
  console.error("Fatal startup error:", error);
  process.exit(1);
});
