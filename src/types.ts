export type LockState = "locked" | "unlocked" | "unknown";

export interface BridgeState {
  status: "ok" | "degraded";
  currentMappedState: LockState;
  lastSuccessfulPollAt: string | null;
  lastPollError: string | null;
}
