import { validateCommand, validateDynamicObjectControl, validateScenario, validateTarget } from "@/server/validation";

describe("protocol validation", () => {
  it("accepts valid drive commands", () => {
    expect(validateCommand({ type: "drive", leftPwm: 120, rightPwm: -120 }).ok).toBe(true);
  });

  it("rejects unsupported commands", () => {
    expect(validateCommand({ type: "spin", leftPwm: 1, rightPwm: 1 }).ok).toBe(false);
  });

  it("rejects out-of-range and non-finite PWM", () => {
    expect(validateCommand({ type: "drive", leftPwm: 300, rightPwm: 0 }).ok).toBe(false);
    expect(validateCommand({ type: "drive", leftPwm: Number.NaN, rightPwm: 0 }).ok).toBe(false);
  });

  it("rejects invalid target coordinates", () => {
    expect(validateTarget({ xCm: 10, yCm: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateTarget({ xCm: 1500, yCm: 0 }).ok).toBe(false);
  });

  it("accepts documented stub scenarios", () => {
    expect(validateScenario({ scenario: "missing-front-sensor" }).ok).toBe(true);
    expect(validateScenario({ scenario: "random-chaos" }).ok).toBe(false);
  });

  it("validates dynamic object start, stop, and speed controls", () => {
    expect(validateDynamicObjectControl({ id: "object-1", action: "start", speedCmPerSec: 20 }).ok).toBe(true);
    expect(validateDynamicObjectControl({ id: "object-1", action: "update-speed", speedCmPerSec: 0 }).ok).toBe(false);
    expect(validateDynamicObjectControl({ id: "", action: "stop" }).ok).toBe(false);
  });
});
