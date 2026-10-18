export type TransportType = "stub" | "gazebo" | "esp32";
export type TransportStatus = "connected" | "idle" | "manual" | "stopped" | "disconnected" | "error";
export type RobotMode = "idle" | "manual" | "autonomous" | "stopped" | "emergency-stop" | "disconnected" | "error";
export type NavigationStatus = "idle" | "target-set" | "planned" | "moving" | "blocked" | "reached" | "stopped" | "unavailable";
export type CadeBehaviourState =
  | "CLEAR"
  | "CAUTION"
  | "STOPPING"
  | "WAITING"
  | "VERIFYING_CLEARANCE"
  | "RESUMING"
  | "REPLANNING"
  | "BLOCKED"
  | "GOAL_REACHED"
  | "ERROR";
export type AdaptiveAction = "CONTINUE" | "SLOW" | "WAIT" | "REROUTE" | "STOP" | "NO_CHANGE";
export type SensorName = "left" | "front" | "right";
export type CardinalDirection = "north" | "south" | "east" | "west" | "none";
export type StubScenario =
  | "normal"
  | "missing-front-sensor"
  | "missing-multiple-sensors"
  | "temporary-disconnect"
  | "rejected-command"
  | "reconnect"
  | "reset-baseline";

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string>;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiFail {
  ok: false;
  error: ApiError;
}

export type ApiResponse<T> = ApiOk<T> | ApiFail;

export interface Pose {
  xCm: number;
  yCm: number;
  thetaDeg: number;
  valid: boolean;
}

export interface SensorReading {
  cm: number | null;
  valid: boolean;
  stale: boolean;
}

export interface RobotState {
  schemaVersion: 1;
  sequence: number;
  timestampMs: number;
  transport: {
    type: TransportType;
    connected: boolean;
    status: TransportStatus;
    notice: string;
  };
  robot: {
    mode: RobotMode;
    pose: Pose;
    emergencyStopLatched: boolean;
  };
  encoders: {
    leftPulses: number;
    rightPulses: number;
  };
  ultrasonic: Record<SensorName, SensorReading>;
  motors: {
    leftAppliedPwm: number;
    rightAppliedPwm: number;
  };
  battery: {
    voltage: number | null;
    valid: boolean;
    capacityJoules: number;
    remainingJoules: number;
    usedJoules: number;
    percent: number;
  };
  navigation: {
    status: NavigationStatus;
    cadeState: CadeBehaviourState;
    lastTransitionReason: string;
    waitStartedMs: number | null;
    clearSinceMs: number | null;
    replanCount: number;
    lastReplanDurationMs: number | null;
    lastReplanRouteFingerprint: string | null;
    lastReplanTrackFingerprint: string | null;
    decision: {
      action: "MOVE_NOMINAL" | "MOVE_CAUTION" | "WAIT" | "VERIFY_CLEAR" | "RESUME" | "REPLAN" | "BLOCKED" | "GOAL_REACHED";
      leftPwm: number;
      rightPwm: number;
      reason: string;
      relevantTrackIds: string[];
      clearForMs: number;
    };
    decisionLog: RoverDecisionLogEntry[];
    activeRun: RoverRunInProgress | null;
    runHistory: RoverRunSummary[];
    recording: SceneRecording | null;
    lastRecording: RecordedScene | null;
    adaptiveDecision: AdaptiveActionEvaluation;
    target: { xCm: number; yCm: number } | null;
    path: Array<{ xCm: number; yCm: number }> | null;
    activeWaypointIndex: number;
    map: {
      resolutionCm: number;
      cells: Array<{ xCm: number; yCm: number; state: "free" | "occupied" | "dynamic" }>;
    };
    staticMap: {
      resolutionCm: number;
      cells: Array<{ xCm: number; yCm: number; state: "occupied" }>;
    };
    dynamicMap: {
      resolutionCm: number;
      cells: Array<{ xCm: number; yCm: number; state: "dynamic" | "observed" }>;
    };
    trajectory: Array<{ xCm: number; yCm: number }>;
    obstacles: DynamicObjectState[];
    tracks: ObstacleTrack[];
    roverMotion: MotionEstimate;
    dynamicInteractions: DynamicInteractionAssessment[];
    config: NavigationConfig;
    world: WorldConfig;
    rayTraceEnabled: boolean;
    fixtureMap: boolean;
  };
  telemetry: {
    sequence: number;
    lastUpdateMs: number;
    stale: boolean;
    valid: boolean;
  };
  diagnostics: {
    latestCommand: CommandResult | null;
    recentEvents: DiagnosticEvent[];
    commandHistory: CommandResult[];
  };
}

export interface TelemetrySample {
  sequence: number;
  timestampMs: number;
  encoders: {
    leftPulses: number;
    rightPulses: number;
  };
  ultrasonic: Record<SensorName, number | null>;
  motors: {
    leftAppliedPwm: number;
    rightAppliedPwm: number;
  };
  batteryVoltage: number | null;
  transportType: TransportType;
  valid: boolean;
}

export type RobotCommand =
  | { type: "drive"; leftPwm: number; rightPwm: number }
  | { type: "stop" }
  | { type: "emergency-stop" }
  | { type: "clear-emergency-stop" }
  | { type: "ping" };

export interface CommandResult {
  commandId: string;
  type: RobotCommand["type"];
  accepted: boolean;
  confirmed: boolean;
  message: string;
  timestampMs: number;
}

export interface DiagnosticEvent {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  timestampMs: number;
}

export interface HealthResponse {
  service: "cade-rover-control-center";
  version: string;
  uptimeMs: number;
  transport: RobotState["transport"];
}

export interface RuntimeMetrics {
  uptimeMs: number;
  apiRequests: number;
  apiSuccesses: number;
  apiFailures: number;
  statusCounts: Record<string, number>;
  averageHandlerMs: number;
  commandCount: number;
  commandAccepted: number;
  commandRejected: number;
  telemetryUpdates: number;
  lastTelemetrySequence: number;
  websocketClients: number;
  transport: RobotState["transport"];
}

export interface NavigationTargetRequest {
  xCm: number;
  yCm: number;
}

export interface NavigationControlResponse {
  navigation: RobotState["navigation"];
  robot: RobotState["robot"];
}

export interface NavigationConfig {
  strategy: "cade" | "rule-based";
  nominalSpeedCmPerSec: number;
  cautionSpeedCmPerSec: number;
  sensorRangeCm: number;
  associationGateCm: number;
  trackStaleMs: number;
  trackExpireMs: number;
  waitBeforeReplanMs: number;
  clearanceConfirmationsRequired: number;
  roverClearanceCm: number;
  hardClearanceCm: number;
  softClearanceCm: number;
  stuckBeforeReplanMs: number;
  stationaryBeforeStaticMs: number;
  goalToleranceCm: number;
  adaptivePlanningEnabled: boolean;
  adaptiveStopHorizonSec: number;
  energyPlanningEnabled: boolean;
  energyCostWeight: number;
  timeCostWeight: number;
  actionSwitchMargin: number;
}

export interface StaticRectObject {
  kind: "rect";
  id: string;
  name: string;
  xCm: number;
  yCm: number;
  widthCm: number;
  heightCm: number;
}

export interface StaticCellObject {
  kind: "cells";
  id: string;
  name: string;
  cells: Array<{ xCm: number; yCm: number }>;
}

export type StaticObject = StaticRectObject | StaticCellObject;

export interface WorldConfig {
  version: number;
  widthCm: number;
  heightCm: number;
  gridCellCm: number;
  roverStart: { xCm: number; yCm: number; thetaDeg: number };
  target: { xCm: number; yCm: number } | null;
  staticObjects: StaticObject[];
  validationErrors: string[];
}

export interface DynamicObjectConfig {
  id: string;
  name: string;
  widthCm: number;
  heightCm: number;
  start: { xCm: number; yCm: number };
  goal: { xCm: number; yCm: number };
  speedCmPerSec: number;
  waypoints?: Array<{ xCm: number; yCm: number }>;
  color?: string;
}

export interface DynamicObjectState extends DynamicObjectConfig {
  xCm: number;
  yCm: number;
  route: Array<{ xCm: number; yCm: number }>;
  waypointIndex: number;
  status: "moving" | "waiting-at-destination" | "stopped" | "blocked";
  direction: CardinalDirection;
  dynamic: true;
  radiusCm: number;
  stuckSinceMs: number | null;
  lastReplanMs: number | null;
}

export interface DynamicObjectControlRequest {
  id: string;
  action: "start" | "stop" | "update-speed" | "delete";
  speedCmPerSec?: number;
}

export interface RoverDecisionLogEntry {
  id: string;
  timestampMs: number;
  pose: { xCm: number; yCm: number; thetaDeg: number };
  action: RobotState["navigation"]["decision"]["action"];
  leftPwm: number;
  rightPwm: number;
  reason: string;
  report: CadeDecisionReport;
}

export interface RoverRunInProgress {
  id: string;
  startedAtMs: number;
  strategy: NavigationConfig["strategy"];
  startPose: { xCm: number; yCm: number; thetaDeg: number };
  target: { xCm: number; yCm: number };
  startBatteryJoules: number;
  trajectoryStartIndex: number;
}

export interface RoverRunSummary extends RoverRunInProgress {
  endedAtMs: number;
  outcome: Extract<NavigationStatus, "reached" | "blocked" | "stopped">;
  endPose: { xCm: number; yCm: number; thetaDeg: number };
  energyEndJoules: number;
  energyUsedJoules: number;
  durationSec: number;
  distanceCm: number;
  replanCount: number;
  decisionCount: number;
  finalReason: string;
}

export interface RecordedScene {
  id: string;
  recordedAtMs: number;
  endedAtMs: number | null;
  endReason: "manual" | "dynamic-objects-finished" | null;
  world: WorldConfig;
  config: NavigationConfig;
  target: { xCm: number; yCm: number } | null;
  objects: Array<DynamicObjectConfig & { startMoving: boolean }>;
}

export interface SceneRecording {
  scene: RecordedScene;
  trackedDynamicIds: string[];
}

export interface CadeDecisionReport {
  strategy: "cade" | "rule-based";
  transitionExplanation: string;
  safetyAssessment: string;
  avoidanceAssessment: string;
  efficiencyAssessment: string;
  goalProgressAssessment: string;
  alternatives: Array<{
    action: string;
    status: "selected" | "rejected" | "deferred";
    reason: string;
    energyJoules: number | null;
    expectedTimeSec: number | null;
  }>;
}

export interface ObstacleTrack {
  id: string;
  lastPosition: { xCm: number; yCm: number };
  previousPosition: { xCm: number; yCm: number } | null;
  lastObservedMs: number;
  previousObservedMs: number | null;
  lastSensor: SensorName;
  lastRangeCm: number;
  rawVelocity: { vxCmPerSec: number; vyCmPerSec: number } | null;
  detectionStatus?: "detected" | "temporarily-unobserved" | "stale" | "lost";
  velocityStatus?: "valid" | "unavailable" | "degraded";
  classifiedDirection: CardinalDirection;
  confidence: "tentative" | "moving" | "stationary" | "stale" | "expired";
  observations: number;
}

export interface MotionEstimate {
  lastPosition: { xCm: number; yCm: number } | null;
  previousPosition: { xCm: number; yCm: number } | null;
  lastObservedMs: number | null;
  previousObservedMs: number | null;
  velocity: { vxCmPerSec: number; vyCmPerSec: number } | null;
  velocityStatus: "valid" | "unavailable" | "degraded";
}

export interface DynamicInteractionAssessment {
  trackId: string;
  detectionStatus: "detected" | "temporarily-unobserved" | "stale" | "lost";
  velocityStatus: "valid" | "unavailable" | "degraded";
  confidence: ObstacleTrack["confidence"];
  relativeMotionStatus: "approaching" | "receding" | "maintaining-separation" | "indeterminate";
  relativePosition: { xCm: number; yCm: number };
  relativeVelocity: { vxCmPerSec: number; vyCmPerSec: number } | null;
  objectSpeedCmPerSec: number | null;
  observationAgeMs: number;
  predictionValid: boolean;
  limitedByUncertainty: boolean;
  closestApproachTimeSec: number | null;
  closestApproachDistanceCm: number | null;
  collisionTimeSec: number | null;
  routeConflict: boolean;
  routeConflictTimeSec: number | null;
}

export interface AdaptiveActionEvaluation {
  action: AdaptiveAction;
  reason: string;
  relevantTrackIds: string[];
  severity: "none" | "caution" | "blocking" | "critical" | "uncertain";
  predictionValid: boolean;
  closestApproachTimeSec: number | null;
  collisionTimeSec: number | null;
  routeConflictTimeSec: number | null;
  estimatedBlockageMs: number | null;
  limitedByUncertainty: boolean;
  mandatory: boolean;
  costEstimates: AdaptiveActionCostEstimate[];
}

export interface AdaptiveActionCostEstimate {
  action: AdaptiveAction;
  available: boolean;
  energyJoules: number | null;
  expectedTimeSec: number | null;
  combinedCost: number | null;
  assumptions: string;
}

export interface LayoutRequest {
  world: Omit<WorldConfig, "version" | "validationErrors">;
}

export interface DynamicObjectRequest {
  object: DynamicObjectConfig;
}

export interface NavigationConfigRequest {
  config: Partial<NavigationConfig>;
}

export interface ScenarioRequest {
  scenario: StubScenario;
}

export type WsMessage =
  | { type: "state"; data: RobotState }
  | { type: "event"; data: DiagnosticEvent }
  | { type: "metrics"; data: RuntimeMetrics };
