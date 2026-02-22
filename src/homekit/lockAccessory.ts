import {
  Accessory,
  Categories,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
  uuid
} from "hap-nodejs";
import type { Logger } from "pino";
import type { HomekitAdvertiser } from "../config";
import type { LockCommandTarget } from "../smartthings/client";
import type { LockState } from "../types";
import { resolveHomekitBind } from "./networkBind";

export type DesiredLockState = Exclude<LockState, "unknown">;

export interface LockAccessoryOptions {
  bridgeName: string;
  homekitUsername: string;
  homekitSetupCode: string;
  homekitPort: number;
  homekitAdvertiser: HomekitAdvertiser;
  homekitBind: string[];
  homekitAutoBind: boolean;
  transitionTimeoutMs?: number;
  deviceId: string;
  logger: Pick<Logger, "info" | "warn">;
  commandHandler: (target: LockCommandTarget) => Promise<void>;
}

export interface LockStateSink {
  updateFromLockState(state: LockState): void;
  setUnknownState(): void;
  getCurrentMappedState(): LockState;
}

export function mapLockStateToCurrentCharacteristicValue(state: LockState): number {
  switch (state) {
    case "locked":
      return Characteristic.LockCurrentState.SECURED;
    case "unlocked":
      return Characteristic.LockCurrentState.UNSECURED;
    case "unknown":
    default:
      return Characteristic.LockCurrentState.UNKNOWN;
  }
}

export function mapDesiredLockStateToTargetCharacteristicValue(state: DesiredLockState): number {
  return state === "locked"
    ? Characteristic.LockTargetState.SECURED
    : Characteristic.LockTargetState.UNSECURED;
}

function mapTargetCharacteristicValueToDesiredState(value: unknown): DesiredLockState {
  if (value === Characteristic.LockTargetState.SECURED) {
    return "locked";
  }

  if (value === Characteristic.LockTargetState.UNSECURED) {
    return "unlocked";
  }

  throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
}

export class LockAccessory implements LockStateSink {
  private readonly accessory: Accessory;
  private readonly lockService: Service;
  private readonly homekitUsername: string;
  private readonly homekitSetupCode: string;
  private readonly homekitPort: number;
  private readonly homekitAdvertiser: HomekitAdvertiser;
  private readonly homekitBind: string[];
  private readonly homekitAutoBind: boolean;
  private readonly transitionTimeoutMs: number;
  private readonly logger: Pick<Logger, "info" | "warn">;
  private readonly commandHandler: (target: LockCommandTarget) => Promise<void>;

  private currentState: LockState = "unknown";
  private targetState: DesiredLockState = "locked";
  private pendingTargetState: DesiredLockState | null = null;
  private transitionTimeoutTimer: NodeJS.Timeout | null = null;
  private commandInFlight = false;
  private published = false;

  constructor(options: LockAccessoryOptions) {
    this.homekitUsername = options.homekitUsername;
    this.homekitSetupCode = options.homekitSetupCode;
    this.homekitPort = options.homekitPort;
    this.homekitAdvertiser = options.homekitAdvertiser;
    this.homekitBind = options.homekitBind;
    this.homekitAutoBind = options.homekitAutoBind;
    this.transitionTimeoutMs = options.transitionTimeoutMs ?? 30_000;
    this.logger = options.logger;
    this.commandHandler = options.commandHandler;

    const accessoryUuid = uuid.generate(`st-hk-bridge:${options.deviceId}`);
    this.accessory = new Accessory(options.bridgeName, accessoryUuid);
    this.accessory.category = Categories.DOOR_LOCK;

    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "SmartThings")
      .setCharacteristic(Characteristic.Model, "Cloud Lock Bridge")
      .setCharacteristic(Characteristic.SerialNumber, options.deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision, "0.1.0");

    this.lockService =
      this.accessory.getService(Service.LockMechanism) ||
      this.accessory.addService(Service.LockMechanism, options.bridgeName);

    this.lockService
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(() => mapLockStateToCurrentCharacteristicValue(this.currentState));

    this.lockService
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => mapDesiredLockStateToTargetCharacteristicValue(this.targetState))
      .onSet(async (value) => {
        const desiredState = mapTargetCharacteristicValueToDesiredState(value);
        await this.requestTargetState(desiredState);
      });

    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      mapLockStateToCurrentCharacteristicValue(this.currentState)
    );
    this.lockService.updateCharacteristic(
      Characteristic.LockTargetState,
      mapDesiredLockStateToTargetCharacteristicValue(this.targetState)
    );
  }

  async publish(): Promise<void> {
    if (this.published) {
      return;
    }

    const bindDecision = resolveHomekitBind(this.homekitBind, this.homekitAutoBind);
    const bindSummary = bindDecision.bind ? bindDecision.bind.join(",") : "unrestricted";
    this.logger.info(
      {
        advertiser: this.homekitAdvertiser,
        bindSource: bindDecision.source,
        bind: bindSummary,
        port: this.homekitPort
      },
      "Publishing HomeKit lock accessory"
    );
    if (!bindDecision.bind && this.homekitAutoBind) {
      this.logger.warn(
        "HomeKit auto-bind found no suitable LAN interface; publishing without bind restrictions"
      );
    }

    await this.accessory.publish({
      username: this.homekitUsername,
      pincode: this.homekitSetupCode,
      category: Categories.DOOR_LOCK,
      port: this.homekitPort,
      advertiser: this.homekitAdvertiser as Parameters<Accessory["publish"]>[0]["advertiser"],
      ...(bindDecision.bind ? { bind: bindDecision.bind } : {})
    });

    this.published = true;
    this.logger.info({ port: this.homekitPort }, "Published HomeKit lock accessory");
  }

  async unpublish(): Promise<void> {
    if (!this.published) {
      return;
    }

    await this.accessory.unpublish();
    this.clearTransitionTimeout();
    this.published = false;
    this.logger.info("Unpublished HomeKit lock accessory");
  }

  updateFromLockState(state: LockState): void {
    this.currentState = state;

    if (state !== "unknown") {
      if (this.pendingTargetState !== null) {
        if (state === this.pendingTargetState) {
          this.targetState = state;
          this.pendingTargetState = null;
          this.clearTransitionTimeout();
        }
      } else {
        this.targetState = state;
      }

      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState,
        mapDesiredLockStateToTargetCharacteristicValue(this.targetState)
      );
    }

    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      mapLockStateToCurrentCharacteristicValue(this.currentState)
    );
  }

  setUnknownState(): void {
    this.currentState = "unknown";
    this.lockService.updateCharacteristic(
      Characteristic.LockCurrentState,
      mapLockStateToCurrentCharacteristicValue("unknown")
    );
  }

  getCurrentMappedState(): LockState {
    return this.currentState;
  }

  getTargetState(): DesiredLockState {
    return this.targetState;
  }

  async requestTargetState(targetState: DesiredLockState): Promise<void> {
    if (this.commandInFlight) {
      throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
    }

    this.commandInFlight = true;

    try {
      const command: LockCommandTarget = targetState === "locked" ? "lock" : "unlock";
      await this.commandHandler(command);

      this.targetState = targetState;
      this.pendingTargetState = targetState;
      this.startTransitionTimeout(targetState);
      this.lockService.updateCharacteristic(
        Characteristic.LockTargetState,
        mapDesiredLockStateToTargetCharacteristicValue(this.targetState)
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to execute lock command through SmartThings");
      if (error instanceof HapStatusError) {
        throw error;
      }
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.commandInFlight = false;
    }
  }

  private startTransitionTimeout(targetState: DesiredLockState): void {
    this.clearTransitionTimeout();

    this.transitionTimeoutTimer = setTimeout(() => {
      if (this.pendingTargetState !== targetState) {
        return;
      }

      this.pendingTargetState = null;

      if (this.currentState !== "unknown") {
        this.targetState = this.currentState;
        this.lockService.updateCharacteristic(
          Characteristic.LockTargetState,
          mapDesiredLockStateToTargetCharacteristicValue(this.targetState)
        );
      }

      this.logger.warn(
        {
          transitionTimeoutMs: this.transitionTimeoutMs,
          targetState,
          currentState: this.currentState
        },
        "Lock transition timed out before observed state reached target"
      );
    }, this.transitionTimeoutMs);

    if (typeof this.transitionTimeoutTimer.unref === "function") {
      this.transitionTimeoutTimer.unref();
    }
  }

  private clearTransitionTimeout(): void {
    if (!this.transitionTimeoutTimer) {
      return;
    }

    clearTimeout(this.transitionTimeoutTimer);
    this.transitionTimeoutTimer = null;
  }
}
