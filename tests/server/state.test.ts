import { ManualClock } from "@/server/clock";
import { RobotStateStore } from "@/server/state";
import type { TelemetrySample } from "@/shared/protocol";

function sample(sequence: number): TelemetrySample {
  return {
    sequence,
    timestampMs: sequence * 100,
    encoders: { leftPulses: sequence, rightPulses: sequence },
    ultrasonic: { left: 10, front: sequence === 3 ? null : 20, right: 30 },
    motors: { leftAppliedPwm: 100, rightAppliedPwm: 100 },
    batteryVoltage: 7.2,
    transportType: "stub",
    valid: true
  };
}

describe("authoritative robot state", () => {
  it("increments state sequence and ignores older telemetry", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.applyTelemetry(sample(2));
    const afterTwo = store.snapshot();
    store.applyTelemetry(sample(1));
    expect(store.snapshot().telemetry.sequence).toBe(2);
    expect(store.snapshot().sequence).toBeGreaterThan(afterTwo.sequence);
  });

  it("represents missing sensor readings as null", () => {
    const store = new RobotStateStore(new ManualClock());
    store.applyTelemetry(sample(3));
    expect(store.snapshot().ultrasonic.front.cm).toBeNull();
    expect(store.snapshot().ultrasonic.front.valid).toBe(false);
  });

  it("stop and emergency-stop results clear applied motors", () => {
    const store = new RobotStateStore(new ManualClock());
    store.applyTelemetry(sample(1));
    store.recordCommand(
      { type: "emergency-stop" },
      { commandId: "cmd-1", type: "emergency-stop", accepted: true, confirmed: true, message: "ok", timestampMs: 0 }
    );
    expect(store.snapshot().robot.emergencyStopLatched).toBe(true);
    expect(store.snapshot().motors.leftAppliedPwm).toBe(0);
  });

  it("reset restores baseline", () => {
    const store = new RobotStateStore(new ManualClock());
    store.applyTelemetry(sample(5));
    store.reset();
    expect(store.snapshot().telemetry.sequence).toBe(0);
    expect(store.snapshot().motors.leftAppliedPwm).toBe(0);
  });

  it("depletes the deterministic test battery from telemetry load and restores it to 100%", () => {
    const store = new RobotStateStore(new ManualClock());
    store.applyTelemetry(sample(1));
    store.applyTelemetry(sample(2));
    expect(store.snapshot().battery.usedJoules).toBeGreaterThan(0);
    expect(store.snapshot().battery.percent).toBeLessThan(100);
    store.refreshTestBattery();
    expect(store.snapshot().battery).toMatchObject({ percent: 100, usedJoules: 0, remainingJoules: 36_000 });
  });
});
