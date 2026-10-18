import type { DynamicObjectControlRequest, DynamicObjectRequest, LayoutRequest, NavigationConfigRequest, NavigationTargetRequest, RobotCommand, ScenarioRequest, StaticObject, StubScenario, WorldConfig } from "@/shared/protocol";

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
}

const commandTypes = new Set(["drive", "stop", "emergency-stop", "clear-emergency-stop", "ping"]);
const scenarios = new Set<StubScenario>([
  "normal",
  "missing-front-sensor",
  "missing-multiple-sensors",
  "temporary-disconnect",
  "reconnect",
  "rejected-command",
  "reset-baseline"
]);

function finiteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export function validateCommand(body: unknown): ValidationResult<RobotCommand> {
  if (!body || typeof body !== "object") {
    return { ok: false, errors: { body: "Command body must be an object." } };
  }

  const candidate = body as Record<string, unknown>;
  if (typeof candidate.type !== "string" || !commandTypes.has(candidate.type)) {
    return { ok: false, errors: { type: "Unsupported command type." } };
  }

  if (candidate.type === "drive") {
    const allowed = new Set(["type", "leftPwm", "rightPwm"]);
    const extra = Object.keys(candidate).filter((key) => !allowed.has(key));
    if (extra.length > 0) {
      return { ok: false, errors: { fields: `Unexpected field(s): ${extra.join(", ")}.` } };
    }
    if (!finiteInteger(candidate.leftPwm) || candidate.leftPwm < -255 || candidate.leftPwm > 255) {
      return { ok: false, errors: { leftPwm: "leftPwm must be a finite integer from -255 to 255." } };
    }
    if (!finiteInteger(candidate.rightPwm) || candidate.rightPwm < -255 || candidate.rightPwm > 255) {
      return { ok: false, errors: { rightPwm: "rightPwm must be a finite integer from -255 to 255." } };
    }
    return { ok: true, value: { type: "drive", leftPwm: candidate.leftPwm, rightPwm: candidate.rightPwm } };
  }

  const allowed = new Set(["type"]);
  const extra = Object.keys(candidate).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return { ok: false, errors: { fields: `Unexpected field(s): ${extra.join(", ")}.` } };
  }
  if (candidate.type === "stop") return { ok: true, value: { type: "stop" } };
  if (candidate.type === "emergency-stop") return { ok: true, value: { type: "emergency-stop" } };
  if (candidate.type === "clear-emergency-stop") return { ok: true, value: { type: "clear-emergency-stop" } };
  return { ok: true, value: { type: "ping" } };
}

export function validateTarget(body: unknown): ValidationResult<NavigationTargetRequest> {
  if (!body || typeof body !== "object") {
    return { ok: false, errors: { body: "Target body must be an object." } };
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.xCm !== "number" || !Number.isFinite(candidate.xCm)) {
    return { ok: false, errors: { xCm: "xCm must be a finite number." } };
  }
  if (typeof candidate.yCm !== "number" || !Number.isFinite(candidate.yCm)) {
    return { ok: false, errors: { yCm: "yCm must be a finite number." } };
  }
  if (Math.abs(candidate.xCm) > 1000 || Math.abs(candidate.yCm) > 1000) {
    return { ok: false, errors: { target: "Target must be within +/-1000 cm of the origin." } };
  }
  return { ok: true, value: { xCm: candidate.xCm, yCm: candidate.yCm } };
}

export function validateScenario(body: unknown): ValidationResult<ScenarioRequest> {
  if (!body || typeof body !== "object") {
    return { ok: false, errors: { body: "Scenario body must be an object." } };
  }
  const scenario = (body as Record<string, unknown>).scenario;
  if (typeof scenario !== "string" || !scenarios.has(scenario as StubScenario)) {
    return { ok: false, errors: { scenario: "Unsupported stub scenario." } };
  }
  return { ok: true, value: { scenario: scenario as StubScenario } };
}

export function validateNavigationConfig(body: unknown): ValidationResult<NavigationConfigRequest> {
  if (!body || typeof body !== "object") return { ok: false, errors: { body: "Config body must be an object." } };
  const config = (body as Record<string, unknown>).config;
  if (!config || typeof config !== "object") return { ok: false, errors: { config: "config must be an object." } };
  const out: NavigationConfigRequest["config"] = {};
  const strategy = (config as Record<string, unknown>).strategy;
  if (strategy !== undefined) {
    if (strategy !== "cade" && strategy !== "rule-based") return { ok: false, errors: { strategy: "strategy must be cade or rule-based." } };
    out.strategy = strategy;
  }
  for (const key of [
    "nominalSpeedCmPerSec",
    "cautionSpeedCmPerSec",
    "waitBeforeReplanMs",
    "associationGateCm",
    "roverClearanceCm",
    "hardClearanceCm",
    "softClearanceCm",
    "stuckBeforeReplanMs",
    "stationaryBeforeStaticMs"
  ] as const) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return { ok: false, errors: { [key]: `${key} must be a positive finite number.` } };
      out[key] = value;
    }
  }
  if (out.hardClearanceCm !== undefined && out.softClearanceCm !== undefined && out.hardClearanceCm > out.softClearanceCm) {
    return { ok: false, errors: { clearance: "hardClearanceCm cannot exceed softClearanceCm." } };
  }
  return { ok: true, value: { config: out } };
}

export function validateDynamicObject(body: unknown): ValidationResult<DynamicObjectRequest> {
  if (!body || typeof body !== "object") return { ok: false, errors: { body: "Dynamic object body must be an object." } };
  const object = (body as Record<string, unknown>).object;
  if (!object || typeof object !== "object") return { ok: false, errors: { object: "object must be provided." } };
  const candidate = object as Record<string, unknown>;
  const requiredNumbers = ["widthCm", "heightCm", "speedCmPerSec"] as const;
  for (const key of requiredNumbers) {
    if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]) || candidate[key] <= 0) return { ok: false, errors: { [key]: `${key} must be positive.` } };
  }
  const start = candidate.start as Record<string, unknown> | undefined;
  const goal = candidate.goal as Record<string, unknown> | undefined;
  if (!start || !goal || typeof start.xCm !== "number" || typeof start.yCm !== "number" || typeof goal.xCm !== "number" || typeof goal.yCm !== "number") {
    return { ok: false, errors: { route: "start and goal must contain numeric xCm/yCm." } };
  }
  const waypoints = candidate.waypoints;
  if (waypoints !== undefined) {
    if (!Array.isArray(waypoints) || waypoints.length < 2 || waypoints.some((point) => !point || typeof point !== "object" || typeof (point as Record<string, unknown>).xCm !== "number" || typeof (point as Record<string, unknown>).yCm !== "number")) {
      return { ok: false, errors: { waypoints: "waypoints must contain at least two numeric xCm/yCm points." } };
    }
  }
  return {
    ok: true,
    value: {
      object: {
        id: String(candidate.id ?? `dynamic-${Date.now()}`),
        name: String(candidate.name ?? "Dynamic object"),
        widthCm: candidate.widthCm as number,
        heightCm: candidate.heightCm as number,
        speedCmPerSec: candidate.speedCmPerSec as number,
        start: { xCm: start.xCm as number, yCm: start.yCm as number },
        goal: { xCm: goal.xCm as number, yCm: goal.yCm as number },
        waypoints: waypoints as Array<{ xCm: number; yCm: number }> | undefined
      }
    }
  };
}

export function validateDynamicObjectControl(body: unknown): ValidationResult<DynamicObjectControlRequest> {
  if (!body || typeof body !== "object") return { ok: false, errors: { body: "Control body must be an object." } };
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) return { ok: false, errors: { id: "Dynamic object id is required." } };
  if (candidate.action !== "start" && candidate.action !== "stop" && candidate.action !== "update-speed" && candidate.action !== "delete") {
    return { ok: false, errors: { action: "action must be start, stop, update-speed, or delete." } };
  }
  if (candidate.speedCmPerSec !== undefined && (typeof candidate.speedCmPerSec !== "number" || !Number.isFinite(candidate.speedCmPerSec) || candidate.speedCmPerSec <= 0)) {
    return { ok: false, errors: { speedCmPerSec: "speedCmPerSec must be a positive finite number." } };
  }
  return { ok: true, value: { id: candidate.id, action: candidate.action, speedCmPerSec: candidate.speedCmPerSec as number | undefined } };
}

export function validateLayout(body: unknown): ValidationResult<LayoutRequest> {
  if (!body || typeof body !== "object") return { ok: false, errors: { body: "Layout body must be an object." } };
  const world = (body as Record<string, unknown>).world;
  if (!world || typeof world !== "object") return { ok: false, errors: { world: "world must be provided." } };
  const candidate = world as Record<string, unknown>;
  if (typeof candidate.widthCm !== "number" || typeof candidate.heightCm !== "number" || typeof candidate.gridCellCm !== "number") {
    return { ok: false, errors: { world: "widthCm, heightCm, and gridCellCm are required numbers." } };
  }
  const roverStart = candidate.roverStart as Record<string, unknown> | undefined;
  if (!roverStart || typeof roverStart.xCm !== "number" || typeof roverStart.yCm !== "number") {
    return { ok: false, errors: { roverStart: "roverStart requires numeric xCm/yCm." } };
  }
  const targetRaw = candidate.target as Record<string, unknown> | null | undefined;
  const staticObjects = Array.isArray(candidate.staticObjects) ? (candidate.staticObjects as StaticObject[]) : [];
  const value: Omit<WorldConfig, "version" | "validationErrors"> = {
    widthCm: candidate.widthCm,
    heightCm: candidate.heightCm,
    gridCellCm: candidate.gridCellCm,
    roverStart: { xCm: roverStart.xCm, yCm: roverStart.yCm, thetaDeg: typeof roverStart.thetaDeg === "number" ? roverStart.thetaDeg : 0 },
    target: targetRaw && typeof targetRaw.xCm === "number" && typeof targetRaw.yCm === "number" ? { xCm: targetRaw.xCm, yCm: targetRaw.yCm } : null,
    staticObjects
  };
  return { ok: true, value: { world: value } };
}
