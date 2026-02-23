import type { LockState } from "../types";

export type DesiredLockState = Exclude<LockState, "unknown">;

export interface ObservedLockStateResult {
  shouldUpdateTargetStateCharacteristic: boolean;
  shouldClearTransitionTimeout: boolean;
}

export interface TransitionTimeoutResult {
  timedOut: boolean;
  shouldUpdateTargetStateCharacteristic: boolean;
}

export class LockStateMachine {
  private currentState: LockState = "unknown";
  private targetState: DesiredLockState = "locked";
  private pendingTargetState: DesiredLockState | null = null;

  getCurrentState(): LockState {
    return this.currentState;
  }

  getTargetState(): DesiredLockState {
    return this.targetState;
  }

  observeLockState(state: LockState): ObservedLockStateResult {
    this.currentState = state;

    if (state === "unknown") {
      return {
        shouldUpdateTargetStateCharacteristic: false,
        shouldClearTransitionTimeout: false
      };
    }

    if (this.pendingTargetState !== null) {
      if (state === this.pendingTargetState) {
        this.targetState = state;
        this.pendingTargetState = null;
        return {
          shouldUpdateTargetStateCharacteristic: true,
          shouldClearTransitionTimeout: true
        };
      }
    } else {
      this.targetState = state;
    }

    return {
      shouldUpdateTargetStateCharacteristic: true,
      shouldClearTransitionTimeout: false
    };
  }

  setUnknownState(): void {
    this.currentState = "unknown";
  }

  beginTransition(targetState: DesiredLockState): void {
    this.targetState = targetState;
    this.pendingTargetState = targetState;
  }

  handleTransitionTimeout(targetState: DesiredLockState): TransitionTimeoutResult {
    if (this.pendingTargetState !== targetState) {
      return {
        timedOut: false,
        shouldUpdateTargetStateCharacteristic: false
      };
    }

    this.pendingTargetState = null;

    if (this.currentState !== "unknown") {
      this.targetState = this.currentState;
      return {
        timedOut: true,
        shouldUpdateTargetStateCharacteristic: true
      };
    }

    return {
      timedOut: true,
      shouldUpdateTargetStateCharacteristic: false
    };
  }
}
