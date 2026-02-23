import { describe, expect, it } from "vitest";
import { LockStateMachine } from "../src/homekit/lockStateMachine";

describe("LockStateMachine", () => {
  it("keeps target state until pending target is observed", () => {
    const machine = new LockStateMachine();

    machine.observeLockState("unlocked");
    machine.beginTransition("locked");

    const staleObservation = machine.observeLockState("unlocked");
    expect(staleObservation.shouldUpdateTargetStateCharacteristic).toBe(true);
    expect(staleObservation.shouldClearTransitionTimeout).toBe(false);
    expect(machine.getTargetState()).toBe("locked");
  });

  it("clears pending transition when expected target is observed", () => {
    const machine = new LockStateMachine();

    machine.observeLockState("unlocked");
    machine.beginTransition("locked");

    const observation = machine.observeLockState("locked");
    expect(observation.shouldUpdateTargetStateCharacteristic).toBe(true);
    expect(observation.shouldClearTransitionTimeout).toBe(true);
    expect(machine.getTargetState()).toBe("locked");
  });

  it("reverts target to current state on timeout when current is known", () => {
    const machine = new LockStateMachine();

    machine.observeLockState("unlocked");
    machine.beginTransition("locked");

    const timeout = machine.handleTransitionTimeout("locked");
    expect(timeout.timedOut).toBe(true);
    expect(timeout.shouldUpdateTargetStateCharacteristic).toBe(true);
    expect(machine.getTargetState()).toBe("unlocked");
  });

  it("does not update target on timeout when current state is unknown", () => {
    const machine = new LockStateMachine();

    machine.beginTransition("locked");
    machine.setUnknownState();

    const timeout = machine.handleTransitionTimeout("locked");
    expect(timeout.timedOut).toBe(true);
    expect(timeout.shouldUpdateTargetStateCharacteristic).toBe(false);
    expect(machine.getTargetState()).toBe("locked");
  });
});
