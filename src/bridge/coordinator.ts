import type { Logger } from "pino";
import type { SmartThingsClientLike } from "../smartthings/client";
import type { BridgeState, LockState } from "../types";
import type { LockStateSink } from "../homekit/lockAccessory";

export interface BridgeCoordinatorOptions {
  client: SmartThingsClientLike;
  accessory: LockStateSink;
  pollIntervalMs: number;
  burstPollIntervalMs: number;
  burstDurationMs: number;
  pollFailuresBeforeUnknown?: number;
  pollFailureGraceMs?: number;
  initialMappedState?: LockState;
  onObservedState?: (state: LockState) => Promise<void> | void;
  logger: Pick<Logger, "debug" | "warn">;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class BridgeCoordinator {
  private static readonly DEFAULT_POLL_FAILURES_BEFORE_UNKNOWN = 3;
  private static readonly DEFAULT_POLL_FAILURE_GRACE_MS = 90_000;

  private readonly client: SmartThingsClientLike;
  private readonly accessory: LockStateSink;
  private readonly pollIntervalMs: number;
  private readonly burstPollIntervalMs: number;
  private readonly burstDurationMs: number;
  private readonly pollFailuresBeforeUnknown: number;
  private readonly pollFailureGraceMs: number;
  private readonly onObservedState?: (state: LockState) => Promise<void> | void;
  private readonly logger: Pick<Logger, "debug" | "warn">;

  private pollTimer: NodeJS.Timeout | null = null;
  private burstTimer: NodeJS.Timeout | null = null;
  private burstWindowEndsAtMs: number | null = null;
  private burstTargetState: Exclude<LockState, "unknown"> | null = null;
  private pollInFlight = false;
  private consecutivePollFailures = 0;
  private firstPollFailureAtMs: number | null = null;

  private bridgeState: BridgeState = {
    status: "degraded",
    currentMappedState: "unknown",
    lastSuccessfulPollAt: null,
    lastPollError: null
  };

  constructor(options: BridgeCoordinatorOptions) {
    this.client = options.client;
    this.accessory = options.accessory;
    this.pollIntervalMs = options.pollIntervalMs;
    this.burstPollIntervalMs = options.burstPollIntervalMs;
    this.burstDurationMs = options.burstDurationMs;
    this.pollFailuresBeforeUnknown =
      options.pollFailuresBeforeUnknown ?? BridgeCoordinator.DEFAULT_POLL_FAILURES_BEFORE_UNKNOWN;
    this.pollFailureGraceMs =
      options.pollFailureGraceMs ?? BridgeCoordinator.DEFAULT_POLL_FAILURE_GRACE_MS;
    this.onObservedState = options.onObservedState;
    this.logger = options.logger;
    this.bridgeState.currentMappedState = options.initialMappedState ?? "unknown";
  }

  start(): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch(() => {
        // poll errors are reflected in bridge state and logged in pollOnce
      });
    }, this.pollIntervalMs);

    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.stopBurstPolling();
  }

  triggerCommandPollBurst(targetState: Exclude<LockState, "unknown">): void {
    const now = Date.now();
    this.burstWindowEndsAtMs = now + this.burstDurationMs;
    this.burstTargetState = targetState;

    this.logger.debug(
      {
        burstTargetState: this.burstTargetState,
        burstPollIntervalMs: this.burstPollIntervalMs,
        burstDurationMs: this.burstDurationMs
      },
      "Starting or extending command burst polling window"
    );

    if (this.burstTimer) {
      return;
    }

    this.burstTimer = setInterval(() => {
      if (this.burstWindowEndsAtMs === null || Date.now() >= this.burstWindowEndsAtMs) {
        this.stopBurstPolling();
        return;
      }

      void this.pollOnce().catch(() => {
        // burst poll errors are reflected in bridge state and logged in pollOnce
      });
    }, this.burstPollIntervalMs);

    if (typeof this.burstTimer.unref === "function") {
      this.burstTimer.unref();
    }
  }

  async pollOnce(): Promise<void> {
    if (this.pollInFlight) {
      this.logger.debug("Skipping poll because previous poll is still running");
      return;
    }

    this.pollInFlight = true;

    try {
      const state = await this.client.getLockStatus();
      this.accessory.updateFromLockState(state);
      this.setHealthyState(state);
      this.consecutivePollFailures = 0;
      this.firstPollFailureAtMs = null;

      if (this.onObservedState) {
        try {
          await this.onObservedState(state);
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to process observed lock state update");
        }
      }

      if (this.burstTargetState !== null && state === this.burstTargetState) {
        this.logger.debug(
          { observedState: state, burstTargetState: this.burstTargetState },
          "Burst polling target state observed; ending burst polling window"
        );
        this.stopBurstPolling();
      }
    } catch (error) {
      const now = Date.now();
      this.consecutivePollFailures += 1;
      this.firstPollFailureAtMs = this.firstPollFailureAtMs ?? now;

      const failureWindowMs = now - this.firstPollFailureAtMs;
      const shouldMarkUnknown =
        this.consecutivePollFailures >= this.pollFailuresBeforeUnknown ||
        failureWindowMs >= this.pollFailureGraceMs;
      const remainingFailuresBeforeUnknown = Math.max(
        0,
        this.pollFailuresBeforeUnknown - this.consecutivePollFailures
      );
      const withinFailureTolerance = !shouldMarkUnknown;

      if (shouldMarkUnknown) {
        this.accessory.setUnknownState();
      }

      this.setDegradedState(stringifyError(error), this.accessory.getCurrentMappedState());
      this.logger.warn(
        {
          err: error,
          consecutivePollFailures: this.consecutivePollFailures,
          failureWindowMs,
          pollFailuresBeforeUnknown: this.pollFailuresBeforeUnknown,
          pollFailureGraceMs: this.pollFailureGraceMs,
          markUnknown: shouldMarkUnknown,
          withinFailureTolerance,
          remainingFailuresBeforeUnknown
        },
        withinFailureTolerance
          ? "Polling SmartThings lock status failed; keeping last known state (within tolerance)"
          : "Polling SmartThings lock status failed; marking HomeKit current state as Unknown"
      );
      throw error;
    } finally {
      this.pollInFlight = false;
    }
  }

  getBridgeState(): BridgeState {
    return { ...this.bridgeState };
  }

  private setHealthyState(state: LockState): void {
    this.bridgeState = {
      status: state === "unknown" ? "degraded" : "ok",
      currentMappedState: state,
      lastSuccessfulPollAt: new Date().toISOString(),
      lastPollError: null
    };
  }

  private setDegradedState(message: string, currentMappedState: LockState): void {
    this.bridgeState = {
      ...this.bridgeState,
      status: "degraded",
      currentMappedState,
      lastPollError: message
    };
  }

  private stopBurstPolling(): void {
    if (!this.burstTimer) {
      this.burstWindowEndsAtMs = null;
      return;
    }

    clearInterval(this.burstTimer);
    this.burstTimer = null;
    this.burstWindowEndsAtMs = null;
    this.burstTargetState = null;
  }
}
