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

  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerTimerDueAtMs: number | null = null;
  private regularPollingEnabled = false;
  private nextRegularPollAtMs: number | null = null;
  private nextBurstPollAtMs: number | null = null;
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
    if (this.regularPollingEnabled) {
      return;
    }

    this.regularPollingEnabled = true;
    this.nextRegularPollAtMs = Date.now() + this.pollIntervalMs;
    this.armNextTimer();
  }

  stop(): void {
    this.regularPollingEnabled = false;
    this.nextRegularPollAtMs = null;
    this.clearBurstState();
    this.stopSchedulerTimer();
  }

  triggerCommandPollBurst(targetState: Exclude<LockState, "unknown">): void {
    const now = Date.now();
    this.burstWindowEndsAtMs = now + this.burstDurationMs;
    this.burstTargetState = targetState;
    this.nextBurstPollAtMs ??= now + this.burstPollIntervalMs;

    this.logger.debug(
      {
        burstTargetState: this.burstTargetState,
        burstPollIntervalMs: this.burstPollIntervalMs,
        burstDurationMs: this.burstDurationMs
      },
      "Starting or extending command burst polling window"
    );

    this.armNextTimer();
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
        this.clearBurstState();
        this.armNextTimer();
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

  private armNextTimer(): void {
    const now = Date.now();
    if (this.burstWindowEndsAtMs !== null && now >= this.burstWindowEndsAtMs) {
      this.clearBurstState();
    }

    let nextDueAtMs: number | null = null;

    if (this.regularPollingEnabled) {
      this.nextRegularPollAtMs ??= now + this.pollIntervalMs;
      nextDueAtMs = this.nextRegularPollAtMs;
    }

    if (this.nextBurstPollAtMs !== null) {
      nextDueAtMs = nextDueAtMs === null ? this.nextBurstPollAtMs : Math.min(nextDueAtMs, this.nextBurstPollAtMs);
    }

    if (
      this.schedulerTimer &&
      this.schedulerTimerDueAtMs !== null &&
      this.schedulerTimerDueAtMs === nextDueAtMs
    ) {
      return;
    }

    this.stopSchedulerTimer();

    if (nextDueAtMs === null) {
      return;
    }

    const delayMs = Math.max(0, nextDueAtMs - now);
    this.schedulerTimerDueAtMs = nextDueAtMs;
    this.schedulerTimer = setTimeout(() => {
      void this.runScheduledPoll().catch(() => {
        // Scheduler poll errors are reflected in bridge state and logged in pollOnce.
      });
    }, delayMs);

    if (typeof this.schedulerTimer.unref === "function") {
      this.schedulerTimer.unref();
    }
  }

  private async runScheduledPoll(): Promise<void> {
    this.stopSchedulerTimer();

    const now = Date.now();
    if (this.burstWindowEndsAtMs !== null && now >= this.burstWindowEndsAtMs) {
      this.clearBurstState();
    }

    const dueRegularPoll = this.nextRegularPollAtMs !== null && now >= this.nextRegularPollAtMs;
    const dueBurstPoll = this.nextBurstPollAtMs !== null && now >= this.nextBurstPollAtMs;

    if (!dueRegularPoll && !dueBurstPoll) {
      this.armNextTimer();
      return;
    }

    if (dueRegularPoll) {
      this.nextRegularPollAtMs = now + this.pollIntervalMs;
    }

    if (dueBurstPoll) {
      this.nextBurstPollAtMs = now + this.burstPollIntervalMs;
    }

    await this.pollOnce().catch(() => {
      // Scheduler poll errors are reflected in bridge state and logged in pollOnce.
    });
    this.armNextTimer();
  }

  private clearBurstState(): void {
    this.burstWindowEndsAtMs = null;
    this.nextBurstPollAtMs = null;
    this.burstTargetState = null;
  }

  private stopSchedulerTimer(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    this.schedulerTimerDueAtMs = null;
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
}
