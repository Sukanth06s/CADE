import { STUB_NOTICE } from "@/shared/roverConfig";
import type {
  CommandResult,
  CadeDecisionReport,
  DynamicObjectConfig,
  DiagnosticEvent,
  LayoutRequest,
  NavigationConfigRequest,
  NavigationTargetRequest,
  RecordedScene,
  RobotCommand,
  RobotMode,
  RobotState,
  SensorName,
  TelemetrySample,
  TransportStatus,
  TransportType
} from "@/shared/protocol";
import type { Clock } from "./clock";
import {
  DEFAULT_NAV_CONFIG,
  advanceDynamicObjects,
  assessDynamicInteractions,
  createDynamicObject,
  defaultWorld,
  detectionsFromSensors,
  distance,
  dynamicMapCells,
  pathFingerprint,
  pathBlockedByTracks,
  planPath,
  rayTraceMap,
  remainingPathDistance,
  selectAdaptiveAction,
  staticMapCells,
  stepToward,
  trackFingerprint,
  updateTracks,
  updateRoverMotion,
  validateWorld
} from "./navigation";

const MAX_EVENTS = 40;
const MAX_COMMANDS = 25;
const CLEARANCE_REQUIRED_MS = 1000;
const NOMINAL_PWM = 110;
const CAUTION_PWM = 60;
const TEST_BATTERY_CAPACITY_JOULES = 36_000;
const TEST_BATTERY_IDLE_WATTS = 2;
const TEST_BATTERY_MOTOR_WATTS = 18;

function zeroSensors(): RobotState["ultrasonic"] {
  return {
    left: { cm: 42, valid: true, stale: false },
    front: { cm: 60, valid: true, stale: false },
    right: { cm: 48, valid: true, stale: false }
  };
}

function defaultDecision(): RobotState["navigation"]["decision"] {
  return {
    action: "MOVE_NOMINAL",
    leftPwm: 0,
    rightPwm: 0,
    reason: "Baseline idle state.",
    relevantTrackIds: [],
    clearForMs: 0
  };
}

function defaultAdaptiveDecision(): RobotState["navigation"]["adaptiveDecision"] {
  return {
    action: "NO_CHANGE",
    reason: "No adaptive motion assessment has run yet.",
    relevantTrackIds: [],
    severity: "none",
    predictionValid: false,
    closestApproachTimeSec: null,
    collisionTimeSec: null,
    routeConflictTimeSec: null,
    estimatedBlockageMs: null,
    limitedByUncertainty: false,
    mandatory: false,
    costEstimates: []
  };
}

export class RobotStateStore {
  private state: RobotState;

  constructor(private readonly clock: Clock, private readonly transportType: TransportType = "stub") {
    this.state = this.baseline();
  }

  snapshot(): RobotState {
    return structuredClone(this.state);
  }

  reset(): RobotState {
    this.state = this.baseline();
    this.addEvent("info", "State reset to deterministic stub baseline.");
    return this.snapshot();
  }

  setTransportStatus(status: TransportStatus, message?: string): RobotState {
    const connected = status !== "disconnected" && status !== "error";
    this.replace({
      transport: { ...this.state.transport, connected, status },
      robot: { ...this.state.robot, mode: this.modeForTransport(status) }
    });
    if (message) this.addEvent(status === "error" ? "error" : "info", message);
    return this.snapshot();
  }

  applyTelemetry(sample: TelemetrySample): RobotState {
    if (!this.validTelemetry(sample)) {
      this.addEvent("warning", "Rejected malformed telemetry sample.");
      return this.snapshot();
    }
    if (sample.sequence <= this.state.telemetry.sequence) {
      this.addEvent("warning", `Ignored stale telemetry sequence ${sample.sequence}.`);
      return this.snapshot();
    }

    const sensors = (Object.keys(sample.ultrasonic) as SensorName[]).reduce<RobotState["ultrasonic"]>(
      (acc, key) => {
        const value = sample.ultrasonic[key];
        acc[key] = { cm: value, valid: value !== null, stale: false };
        return acc;
      },
      { ...zeroSensors() }
    );

    const mode = this.state.navigation.status === "moving"
      ? "autonomous"
      : this.state.robot.emergencyStopLatched
      ? "emergency-stop"
      : sample.motors.leftAppliedPwm === 0 && sample.motors.rightAppliedPwm === 0
        ? "idle"
        : "manual";

    const elapsedSec = this.state.telemetry.sequence === 0
      ? 0
      : Math.max(0, Math.min(1, (sample.timestampMs - this.state.telemetry.lastUpdateMs) / 1000));
    const pwmFraction = Math.min(1, (Math.abs(sample.motors.leftAppliedPwm) + Math.abs(sample.motors.rightAppliedPwm)) / 510);
    const consumedJoules = elapsedSec * (TEST_BATTERY_IDLE_WATTS + pwmFraction * TEST_BATTERY_MOTOR_WATTS);
    const remainingJoules = Math.max(0, this.state.battery.remainingJoules - consumedJoules);

    this.replace({
      transport: { ...this.state.transport, connected: true, status: mode === "manual" ? "manual" : "idle" },
      robot: { ...this.state.robot, mode },
      encoders: {
        leftPulses: sample.encoders.leftPulses,
        rightPulses: sample.encoders.rightPulses
      },
      ultrasonic: sensors,
      motors: {
        leftAppliedPwm: sample.motors.leftAppliedPwm,
        rightAppliedPwm: sample.motors.rightAppliedPwm
      },
      battery: {
        voltage: sample.batteryVoltage,
        valid: sample.batteryVoltage !== null,
        capacityJoules: this.state.battery.capacityJoules,
        remainingJoules,
        usedJoules: this.state.battery.capacityJoules - remainingJoules,
        percent: (remainingJoules / this.state.battery.capacityJoules) * 100
      },
      telemetry: {
        sequence: sample.sequence,
        lastUpdateMs: sample.timestampMs,
        stale: false,
        valid: sample.valid
      }
    });
    return this.snapshot();
  }

  refreshTestBattery(): RobotState {
    this.replace({
      battery: {
        ...this.state.battery,
        capacityJoules: TEST_BATTERY_CAPACITY_JOULES,
        remainingJoules: TEST_BATTERY_CAPACITY_JOULES,
        usedJoules: 0,
        percent: 100
      }
    });
    this.addEvent("info", "Test battery recharged to 100%.");
    return this.snapshot();
  }

  markTelemetryStale(message = "Telemetry stream is stale."): RobotState {
    this.replace({
      telemetry: { ...this.state.telemetry, stale: true },
      ultrasonic: {
        left: { ...this.state.ultrasonic.left, stale: true },
        front: { ...this.state.ultrasonic.front, stale: true },
        right: { ...this.state.ultrasonic.right, stale: true }
      }
    });
    this.addEvent("warning", message);
    return this.snapshot();
  }

  recordCommand(command: RobotCommand, result: CommandResult): RobotState {
    const history = [result, ...this.state.diagnostics.commandHistory].slice(0, MAX_COMMANDS);
    this.replace({
      diagnostics: {
        ...this.state.diagnostics,
        latestCommand: result,
        commandHistory: history
      }
    });
    if (command.type === "emergency-stop" && result.accepted) {
      this.replace({
        robot: { ...this.state.robot, mode: "emergency-stop", emergencyStopLatched: true },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        transport: { ...this.state.transport, status: "stopped" },
        navigation: {
          ...this.state.navigation,
          status: "stopped",
          cadeState: "WAITING",
          clearSinceMs: null,
          decision: { action: "WAIT", leftPwm: 0, rightPwm: 0, reason: "Emergency stop latched.", relevantTrackIds: [], clearForMs: 0 }
        }
      });
      this.addEvent("warning", "Emergency stop latched. Movement commands are locked out until cleared.");
    }
    if (command.type === "clear-emergency-stop" && result.accepted) {
      this.replace({
        robot: { ...this.state.robot, mode: "idle", emergencyStopLatched: false },
        transport: { ...this.state.transport, status: "idle" }
      });
      this.addEvent("info", "Emergency stop latch cleared.");
    }
    if (command.type === "stop" && result.accepted) {
      this.replace({
        robot: { ...this.state.robot, mode: "stopped" },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        transport: { ...this.state.transport, status: "stopped" },
        navigation: {
          ...this.state.navigation,
          status: "stopped",
          cadeState: "WAITING",
          clearSinceMs: null,
          decision: { action: "WAIT", leftPwm: 0, rightPwm: 0, reason: "Manual stop command accepted.", relevantTrackIds: [], clearForMs: 0 }
        }
      });
    }
    return this.snapshot();
  }

  setNavigationTarget(target: NavigationTargetRequest): RobotState {
    const world = { ...this.state.navigation.world, target: { xCm: target.xCm, yCm: target.yCm } };
    const targetInBounds = Math.abs(target.xCm) <= world.widthCm / 2 && Math.abs(target.yCm) <= world.heightCm / 2;
    const path = targetInBounds ? planPath(this.state.robot.pose, world.target, world, this.state.navigation.config) : null;
    const finalTarget = path?.[path.length - 1] ?? world.target;
    const blockedReason = !targetInBounds
      ? `Target is outside the navigation world (+/-${world.widthCm / 2} cm X, +/-${world.heightCm / 2} cm Y).`
      : "Target blocked by static layout.";
    this.replace({
      navigation: {
        ...this.state.navigation,
        world,
        status: path ? "planned" : "blocked",
        cadeState: path ? "CLEAR" : "BLOCKED",
        clearSinceMs: null,
        lastTransitionReason: path ? "Target accepted and cardinal A* path planned." : blockedReason,
        decision: path
          ? { action: "MOVE_NOMINAL", leftPwm: 0, rightPwm: 0, reason: "Target planned; press Start to move.", relevantTrackIds: [], clearForMs: 0 }
          : { action: "BLOCKED", leftPwm: 0, rightPwm: 0, reason: blockedReason, relevantTrackIds: [], clearForMs: 0 },
        target: finalTarget,
        path,
        activeWaypointIndex: path && path.length > 1 ? 1 : 0,
        fixtureMap: false
      }
    });
    this.addEvent(
      path ? "info" : "warning",
      path
        ? `A* route planned with ${path.length} grid waypoints.`
        : blockedReason
    );
    return this.snapshot();
  }

  startNavigation(): RobotState {
    if (!this.state.navigation.target) {
      this.addEvent("warning", "Navigation cannot start until a target is set.");
      return this.snapshot();
    }
    if (this.state.robot.emergencyStopLatched) {
      this.addEvent("warning", "Navigation blocked by emergency-stop latch.");
      return this.snapshot();
    }
    if (this.state.battery.remainingJoules <= 0) {
      this.addEvent("warning", "Navigation blocked: test battery is depleted. Recharge before starting.");
      return this.snapshot();
    }
    const path = planPath(this.state.robot.pose, this.state.navigation.target, this.state.navigation.world, this.state.navigation.config);
    if (!path) {
      this.replace({
        navigation: { ...this.state.navigation, status: "blocked", cadeState: "BLOCKED", lastTransitionReason: "No valid path from current pose to target.", path: null, activeWaypointIndex: 0 },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 }
      });
      this.addEvent("warning", "A* could not find a path to the selected target.");
      return this.snapshot();
    }
    this.replace({
      robot: { ...this.state.robot, mode: "autonomous" },
      motors: { leftAppliedPwm: 110, rightAppliedPwm: 110 },
      navigation: {
        ...this.state.navigation,
        status: "moving",
        cadeState: "CLEAR",
        clearSinceMs: null,
        lastTransitionReason: "Navigation started on planned route.",
        decision: { action: "MOVE_NOMINAL", leftPwm: NOMINAL_PWM, rightPwm: NOMINAL_PWM, reason: "Path clear; moving at nominal speed.", relevantTrackIds: [], clearForMs: 0 },
        activeRun: {
          id: `run-${this.clock.now()}-${this.state.sequence + 1}`,
          startedAtMs: this.clock.now(),
          strategy: this.state.navigation.config.strategy,
          startPose: { xCm: this.state.robot.pose.xCm, yCm: this.state.robot.pose.yCm, thetaDeg: this.state.robot.pose.thetaDeg },
          target: { ...this.state.navigation.target },
          startBatteryJoules: this.state.battery.remainingJoules,
          trajectoryStartIndex: this.state.navigation.trajectory.length
        },
        path,
        activeWaypointIndex: path.length > 1 ? 1 : 0,
        rayTraceEnabled: true
      }
    });
    this.addEvent("info", "Navigation started. Rover will follow the planned route and replan around dynamic obstacles.");
    return this.snapshot();
  }

  stopNavigation(reason = "Navigation stopped by operator."): RobotState {
    this.replace({
      robot: { ...this.state.robot, mode: "stopped" },
      motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
      navigation: {
        ...this.state.navigation,
        status: "stopped",
        cadeState: "WAITING",
        clearSinceMs: null,
        lastTransitionReason: reason,
        waitStartedMs: this.clock.now(),
        decision: { action: "WAIT", leftPwm: 0, rightPwm: 0, reason, relevantTrackIds: [], clearForMs: 0 }
      }
    });
    this.addEvent("info", reason);
    return this.snapshot();
  }

  addDynamicObject(config?: DynamicObjectConfig): RobotState {
    const count = this.state.navigation.obstacles.length + 1;
    const requested: DynamicObjectConfig = config ?? {
      id: `dynamic-${count}`,
      name: `Dynamic object ${count}`,
      widthCm: 22,
      heightCm: 22,
      start: { xCm: -120, yCm: 45 + count * 20 },
      goal: { xCm: 120, yCm: 45 + count * 20 },
      speedCmPerSec: 22
    };
    const dynamicObject = createDynamicObject(requested, this.state.navigation.world, this.state.navigation.config, this.state.navigation.obstacles);
    if (!dynamicObject) {
      this.addEvent("warning", "Dynamic object route rejected: route must be cardinal, collision-free, and inside the static layout.");
      return this.snapshot();
    }
    const stoppedObject = { ...dynamicObject, status: "stopped" as const, direction: "none" as const };
    this.replace({
      navigation: {
        ...this.state.navigation,
        obstacles: [...this.state.navigation.obstacles, stoppedObject],
        map: {
          ...this.state.navigation.map,
          cells: [...this.state.navigation.map.cells, { xCm: stoppedObject.xCm, yCm: stoppedObject.yCm, state: "dynamic" }]
        },
        dynamicMap: {
          resolutionCm: this.state.navigation.world.gridCellCm,
          cells: dynamicMapCells([...this.state.navigation.obstacles, stoppedObject], this.state.navigation.tracks, this.state.navigation.world)
        }
      }
    });
    this.addEvent("info", `Dynamic object ${stoppedObject.id} is configured and stopped at its start position.`);
    return this.snapshot();
  }

  hasDynamicObject(id: string): boolean {
    return this.state.navigation.obstacles.some((object) => object.id === id);
  }

  controlDynamicObject(id: string, action: "start" | "stop" | "update-speed" | "delete", speedCmPerSec?: number): RobotState {
    const object = this.state.navigation.obstacles.find((candidate) => candidate.id === id);
    if (!object) {
      this.addEvent("warning", `Dynamic object ${id} was not found.`);
      return this.snapshot();
    }
    if (action === "delete") {
      const obstacles = this.state.navigation.obstacles.filter((candidate) => candidate.id !== id);
      this.replace({ navigation: { ...this.state.navigation, obstacles, dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicMapCells(obstacles, this.state.navigation.tracks, this.state.navigation.world) } } });
      this.addEvent("info", `Dynamic object ${id} deleted.`);
      return this.snapshot();
    }
    const nextSpeed = speedCmPerSec ?? object.speedCmPerSec;
    if (!Number.isFinite(nextSpeed) || nextSpeed <= 0) {
      this.addEvent("warning", "Dynamic object speed must be a positive finite number.");
      return this.snapshot();
    }
    const obstacles = this.state.navigation.obstacles.map((candidate) => {
      if (candidate.id !== id) return candidate;
      if (action === "stop") return { ...candidate, speedCmPerSec: nextSpeed, status: "stopped" as const, direction: "none" as const, stuckSinceMs: null, lastReplanMs: null };
      if (action === "start") {
        const hasRemainingRoute = candidate.waypointIndex < candidate.route.length;
        return { ...candidate, speedCmPerSec: nextSpeed, status: hasRemainingRoute ? "moving" as const : "waiting-at-destination" as const, stuckSinceMs: null, lastReplanMs: null };
      }
      return { ...candidate, speedCmPerSec: nextSpeed };
    });
    this.replace({
      navigation: {
        ...this.state.navigation,
        obstacles,
        dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicMapCells(obstacles, this.state.navigation.tracks, this.state.navigation.world) }
      }
    });
    const verb = action === "update-speed" ? "speed updated" : action === "start" ? "started" : "stopped";
    this.addEvent("info", `Dynamic object ${id} ${verb} at ${nextSpeed.toFixed(1)} cm/s.`);
    return this.snapshot();
  }

  stopAllDynamicObjects(): RobotState {
    const obstacles = this.state.navigation.obstacles.map((object) => ({
      ...object,
      status: "stopped" as const,
      direction: "none" as const,
      stuckSinceMs: null,
      lastReplanMs: null
    }));
    this.replace({
      navigation: {
        ...this.state.navigation,
        obstacles,
        dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicMapCells(obstacles, this.state.navigation.tracks, this.state.navigation.world) }
      }
    });
    this.addEvent("info", `Stopped all ${obstacles.length} dynamic object(s).`);
    return this.snapshot();
  }

  startSceneRecording(): RobotState {
    const scene = this.captureScene();
    const trackedDynamicIds = this.state.navigation.obstacles.filter((object) => object.status === "moving" || object.status === "blocked").map((object) => object.id);
    this.replace({ navigation: { ...this.state.navigation, recording: { scene, trackedDynamicIds }, lastRecording: null } });
    this.addEvent("info", `Scene recording started for ${trackedDynamicIds.length} moving dynamic object(s).`);
    return this.snapshot();
  }

  stopSceneRecording(reason: "manual" | "dynamic-objects-finished" = "manual"): RobotState {
    const recording = this.state.navigation.recording;
    if (!recording) return this.snapshot();
    const completed: RecordedScene = { ...recording.scene, endedAtMs: this.clock.now(), endReason: reason };
    this.replace({ navigation: { ...this.state.navigation, recording: null, lastRecording: completed } });
    this.addEvent("info", reason === "manual" ? "Scene recording stopped by operator." : "Scene recording completed: all tracked dynamic objects reached their goals.");
    return this.snapshot();
  }

  replayRecordedScene(): RobotState {
    const scene = this.state.navigation.lastRecording ?? this.state.navigation.recording?.scene;
    if (!scene) {
      this.addEvent("warning", "No recorded scene is available to replay.");
      return this.snapshot();
    }
    const world = structuredClone(scene.world);
    const objects = scene.objects.reduce<RobotState["navigation"]["obstacles"]>((created, specification) => {
      const object = createDynamicObject(specification, world, scene.config, created);
      if (!object) return created;
      return [...created, { ...object, status: specification.startMoving ? "moving" : "stopped", direction: "none" }];
    }, []);
    const target = scene.target ? { ...scene.target } : null;
    const path = target ? planPath(world.roverStart, target, world, scene.config) : null;
    this.replace({
      robot: { ...this.state.robot, mode: "idle", pose: { ...world.roverStart, valid: true } },
      motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
      navigation: {
        ...this.state.navigation,
        status: target ? (path ? "planned" : "blocked") : "idle",
        cadeState: path || !target ? "CLEAR" : "BLOCKED",
        lastTransitionReason: "Recorded scene replayed. Rover and dynamic objects returned to their recorded starting positions.",
        waitStartedMs: null,
        clearSinceMs: null,
        replanCount: 0,
        lastReplanDurationMs: null,
        lastReplanRouteFingerprint: null,
        lastReplanTrackFingerprint: null,
        decision: target && !path ? { action: "BLOCKED", leftPwm: 0, rightPwm: 0, reason: "Recorded target has no valid path in the restored scene.", relevantTrackIds: [], clearForMs: 0 } : { action: "MOVE_NOMINAL", leftPwm: 0, rightPwm: 0, reason: target ? "Recorded target restored; press Start to run the rover." : "Recorded scene restored.", relevantTrackIds: [], clearForMs: 0 },
        target,
        path,
        activeWaypointIndex: path && path.length > 1 ? 1 : 0,
        map: { resolutionCm: world.gridCellCm, cells: [] },
        staticMap: { resolutionCm: world.gridCellCm, cells: staticMapCells(world) },
        dynamicMap: { resolutionCm: world.gridCellCm, cells: dynamicMapCells(objects, [], world) },
        trajectory: [{ xCm: world.roverStart.xCm, yCm: world.roverStart.yCm }],
        obstacles: objects,
        tracks: [],
        roverMotion: { lastPosition: null, previousPosition: null, lastObservedMs: null, previousObservedMs: null, velocity: null, velocityStatus: "unavailable" },
        dynamicInteractions: [],
        config: structuredClone(scene.config),
        world,
        recording: null,
        lastRecording: this.state.navigation.lastRecording ?? scene
      }
    });
    this.addEvent("info", "Recorded scene replayed. Dynamic objects were reset to their original starting positions.");
    return this.snapshot();
  }

  private captureScene(): RecordedScene {
    return {
      id: `recording-${this.clock.now()}-${this.state.sequence + 1}`,
      recordedAtMs: this.clock.now(),
      endedAtMs: null,
      endReason: null,
      world: structuredClone(this.state.navigation.world),
      config: structuredClone(this.state.navigation.config),
      target: this.state.navigation.target ? { ...this.state.navigation.target } : null,
      objects: this.state.navigation.obstacles.map((object) => ({
        id: object.id,
        name: object.name,
        widthCm: object.widthCm,
        heightCm: object.heightCm,
        start: { ...object.start },
        goal: { ...object.goal },
        speedCmPerSec: object.speedCmPerSec,
        waypoints: object.route.map((point) => ({ ...point })),
        color: object.color,
        startMoving: object.status === "moving" || object.status === "blocked"
      }))
    };
  }

  advanceNavigation(dtSec: number): RobotState {
    const recording = this.state.navigation.recording;
    if (recording && recording.trackedDynamicIds.length > 0 && recording.trackedDynamicIds.every((id) => this.state.navigation.obstacles.find((object) => object.id === id)?.status === "waiting-at-destination")) {
      this.stopSceneRecording("dynamic-objects-finished");
    }
    const now = this.clock.now();
    const movedObstacles = advanceDynamicObjects(this.state.navigation.obstacles, this.state.navigation.world, dtSec, this.state.robot.pose, this.state.navigation.config, now);
    const sensorOutput = detectionsFromSensors(this.state.robot.pose, this.state.navigation.world, movedObstacles, this.state.navigation.config);
    const detections = sensorOutput.detections.map((detection) => ({ ...detection, timestampMs: now }));
    const tracks = updateTracks(this.state.navigation.tracks, detections, now, this.state.navigation.config);
    const roverMotion = updateRoverMotion(this.state.navigation.roverMotion, this.state.robot.pose, now);
    const dynamicInteractions = assessDynamicInteractions(roverMotion, this.state.robot.pose, tracks, this.state.navigation.path, this.state.navigation.activeWaypointIndex, this.state.navigation.config, now);
    const hasPredictedRouteConflict = dynamicInteractions.some((interaction) => interaction.routeConflict && interaction.predictionValid);
    // Collision checks remain at the control rate; candidate-route economics only need a
    // bounded planning cadence, avoiding an A* search for every 100 ms sensor update.
    const shouldEvaluateDetour = hasPredictedRouteConflict
      && this.state.navigation.config.energyPlanningEnabled
      && now % 1000 < dtSec * 1000;
    const candidateDetour = shouldEvaluateDetour && this.state.navigation.target
      ? planPath(this.state.robot.pose, this.state.navigation.target, this.state.navigation.world, this.state.navigation.config, tracks.filter((track) => track.confidence !== "stale" && track.confidence !== "expired").map((track) => track.lastPosition))
      : null;
    let adaptiveDecision = selectAdaptiveAction(
      dynamicInteractions,
      this.state.navigation.config,
      this.state.navigation.waitStartedMs === null ? null : now - this.state.navigation.waitStartedMs,
      remainingPathDistance(this.state.navigation.path, this.state.navigation.activeWaypointIndex, this.state.robot.pose),
      { rerouteDistanceCm: candidateDetour ? remainingPathDistance(candidateDetour, candidateDetour.length > 1 ? 1 : 0, this.state.robot.pose) : null }
    );
    const tracedCells = this.state.navigation.rayTraceEnabled
      ? rayTraceMap(this.state.robot.pose, this.state.navigation.world, movedObstacles, this.state.navigation.map.cells, this.state.navigation.config)
      : this.state.navigation.map.cells;
    const dynamicCells = dynamicMapCells(movedObstacles, tracks, this.state.navigation.world);
    let nextState: Partial<RobotState> = {
      navigation: {
        ...this.state.navigation,
        obstacles: movedObstacles,
        tracks,
        roverMotion,
        dynamicInteractions,
        adaptiveDecision,
        map: { ...this.state.navigation.map, cells: tracedCells },
        dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells }
      },
      ultrasonic: {
        left: { cm: sensorOutput.readings.left, valid: sensorOutput.readings.left !== null, stale: false },
        front: { cm: sensorOutput.readings.front, valid: sensorOutput.readings.front !== null, stale: false },
        right: { cm: sensorOutput.readings.right, valid: sensorOutput.readings.right !== null, stale: false }
      }
    };

    if (this.state.navigation.status !== "moving" || !this.state.navigation.target) {
      this.replace(nextState);
      return this.snapshot();
    }

    let path = this.state.navigation.path;
    let waypointIndex = this.state.navigation.activeWaypointIndex;
    if (!path) {
      this.replace({
        ...nextState,
        robot: { ...this.state.robot, mode: "stopped" },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        navigation: {
          ...this.state.navigation,
          obstacles: movedObstacles,
          tracks,
          roverMotion,
          dynamicInteractions,
          adaptiveDecision,
          map: { ...this.state.navigation.map, cells: tracedCells },
          dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
          status: "blocked",
          path: null,
          activeWaypointIndex: 0
        }
      });
      this.addEvent("warning", "Navigation stopped because no path is available.");
      return this.snapshot();
    }
    const activeTracks = tracks.filter((track) => track.confidence !== "expired" && track.confidence !== "stale");
    const hardObjectProximity = movedObstacles.some(
      (object) => distance(this.state.robot.pose, object) <= object.radiusCm + this.state.navigation.config.hardClearanceCm
    );
    if (hardObjectProximity) {
      adaptiveDecision = {
        ...adaptiveDecision,
        action: "STOP",
        reason: "A dynamic object entered the mandatory hard safety boundary.",
        severity: "critical",
        mandatory: true
      };
      const decision: RobotState["navigation"]["decision"] = {
        action: "WAIT",
        leftPwm: 0,
        rightPwm: 0,
        reason: "Dynamic object entered the hard boundary; rover stopped immediately.",
        relevantTrackIds: activeTracks.map((track) => track.id),
        clearForMs: 0
      };
      this.replace({
        ...nextState,
        robot: { ...this.state.robot, mode: "stopped" },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        navigation: {
          ...this.state.navigation,
          obstacles: movedObstacles,
          tracks,
          roverMotion,
          dynamicInteractions,
          adaptiveDecision,
          map: { ...this.state.navigation.map, cells: tracedCells },
          dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
          cadeState: "WAITING",
          status: "moving",
          waitStartedMs: this.state.navigation.waitStartedMs ?? this.clock.now(),
          clearSinceMs: null,
          decision,
          lastTransitionReason: decision.reason
        }
      });
      return this.snapshot();
    }
    const nextPathWindow = path.slice(Math.max(0, waypointIndex), waypointIndex + 4);
    const softRelevantTracks = activeTracks.filter((track) => {
      if (track.confidence === "expired" || track.confidence === "stale") return false;
      const nearPath = nextPathWindow.some(
        (point) =>
          distance(point, track.lastPosition) <=
          this.state.navigation.config.softClearanceCm + this.state.navigation.world.gridCellCm
      );
      const velocity = track.rawVelocity;
      const toRover = {
        x: this.state.robot.pose.xCm - track.lastPosition.xCm,
        y: this.state.robot.pose.yCm - track.lastPosition.yCm
      };
      const approaching =
        velocity !== null &&
        Math.hypot(toRover.x, toRover.y) <= this.state.navigation.config.sensorRangeCm &&
        velocity.vxCmPerSec * toRover.x + velocity.vyCmPerSec * toRover.y > 20;
      return nearPath || approaching;
    });
    const hardRelevantTracks = activeTracks.filter((track) =>
      nextPathWindow.some(
        (point) =>
          distance(point, track.lastPosition) <=
          this.state.navigation.config.hardClearanceCm + this.state.navigation.world.gridCellCm
      )
    );
    const blockedByHardObservation = pathBlockedByTracks(path, waypointIndex, tracks, this.state.navigation.world, this.state.navigation.config.hardClearanceCm);
    const directlyApproaching = softRelevantTracks.some((track) => {
      if (!track.rawVelocity) return false;
      const toRover = {
        x: this.state.robot.pose.xCm - track.lastPosition.xCm,
        y: this.state.robot.pose.yCm - track.lastPosition.yCm
      };
      return track.rawVelocity.vxCmPerSec * toRover.x + track.rawVelocity.vyCmPerSec * toRover.y > 20;
    });
    const multipleRelevant = softRelevantTracks.length >= 2;
    const adaptiveHoldRequested = adaptiveDecision.action === "STOP" || adaptiveDecision.action === "WAIT";
    const adaptiveSlowRequested = adaptiveDecision.action === "SLOW";
    const softHazardPresent = softRelevantTracks.length > 0 || adaptiveSlowRequested;
    const hardHazardPresent = blockedByHardObservation || hardRelevantTracks.length > 0 || directlyApproaching || multipleRelevant || adaptiveHoldRequested;
    let cadeState = this.state.navigation.cadeState;
    let speed = this.state.navigation.config.nominalSpeedCmPerSec;
    let decision: RobotState["navigation"]["decision"] = {
      action: "MOVE_NOMINAL",
      leftPwm: NOMINAL_PWM,
      rightPwm: NOMINAL_PWM,
      reason: "Path clear; moving at nominal speed.",
      relevantTrackIds: softRelevantTracks.map((track) => track.id),
      clearForMs: this.state.navigation.clearSinceMs === null ? 0 : now - this.state.navigation.clearSinceMs
    };

    if (hardHazardPresent) {
      const waitStartedMs = this.state.navigation.waitStartedMs ?? now;
      const waitForMs = now - waitStartedMs;
      const staleStationaryTrack = softRelevantTracks.some(
        (track) => track.confidence === "stationary" && now - track.lastObservedMs >= this.state.navigation.config.stationaryBeforeStaticMs
      );
      const replanAfterMs = this.state.navigation.config.strategy === "rule-based" ? 3000 : this.state.navigation.config.stuckBeforeReplanMs;
      const shouldReplan = adaptiveDecision.action === "REROUTE" || waitForMs >= replanAfterMs || staleStationaryTrack;
      if (shouldReplan) {
        cadeState = "REPLANNING";
        decision = {
          action: "REPLAN",
          leftPwm: 0,
          rightPwm: 0,
          reason: adaptiveDecision.action === "REROUTE"
            ? adaptiveDecision.reason
            : staleStationaryTrack
            ? "Obstacle stayed stationary long enough to treat as a temporary static block; replanning."
            : `Rover has been stuck for ${waitForMs} ms; replanning around active obstacle tracks.`,
          relevantTrackIds: softRelevantTracks.map((track) => track.id),
          clearForMs: 0
        };
      } else {
        const reason = adaptiveHoldRequested
          ? adaptiveDecision.reason
          : directlyApproaching
          ? "Obstacle is directly approaching rover; holding position until all relevant tracks clear."
          : multipleRelevant
            ? "Multiple relevant obstacles detected; holding position until all clear."
            : "Obstacle crossed the hard clearance boundary; holding position and continuing CADE checks.";
        cadeState = "WAITING";
        decision = { action: "WAIT", leftPwm: 0, rightPwm: 0, reason, relevantTrackIds: softRelevantTracks.map((track) => track.id), clearForMs: 0 };
        this.replace({
          ...nextState,
          robot: { ...this.state.robot, mode: "stopped" },
          motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
          navigation: {
            ...this.state.navigation,
            obstacles: movedObstacles,
            tracks,
            roverMotion,
            dynamicInteractions,
            adaptiveDecision,
            map: { ...this.state.navigation.map, cells: tracedCells },
            dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
            cadeState,
            status: "moving",
            waitStartedMs,
            clearSinceMs: null,
            decision,
            lastTransitionReason: reason
          }
        });
        return this.snapshot();
      }
    } else if (softHazardPresent) {
      const reason = adaptiveSlowRequested
        ? adaptiveDecision.reason
        : directlyApproaching
        ? "Obstacle is directly approaching rover; holding position until all relevant tracks clear."
        : multipleRelevant
          ? "Multiple relevant obstacles detected; holding position until all clear."
          : "Obstacle inside soft clearance boundary; reducing both motor PWM by 50 instead of stopping.";
      cadeState = "CAUTION";
      speed = this.state.navigation.config.cautionSpeedCmPerSec;
      decision = { action: "MOVE_CAUTION", leftPwm: CAUTION_PWM, rightPwm: CAUTION_PWM, reason, relevantTrackIds: softRelevantTracks.map((track) => track.id), clearForMs: 0 };
    } else if (cadeState === "WAITING" || cadeState === "VERIFYING_CLEARANCE" || cadeState === "CAUTION") {
      const clearSinceMs = this.state.navigation.clearSinceMs ?? now;
      const clearForMs = now - clearSinceMs;
      if (clearForMs < CLEARANCE_REQUIRED_MS) {
        cadeState = "VERIFYING_CLEARANCE";
        decision = {
          action: "VERIFY_CLEAR",
          leftPwm: 0,
          rightPwm: 0,
          reason: `Route appears clear for ${clearForMs} ms; waiting for ${CLEARANCE_REQUIRED_MS} ms minimum.`,
          relevantTrackIds: [],
          clearForMs
        };
        this.replace({
          ...nextState,
          robot: { ...this.state.robot, mode: "stopped" },
          motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
          navigation: {
            ...this.state.navigation,
            obstacles: movedObstacles,
            tracks,
            roverMotion,
            dynamicInteractions,
            adaptiveDecision,
            map: { ...this.state.navigation.map, cells: tracedCells },
            dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
            cadeState,
            status: "moving",
            clearSinceMs,
            decision,
            lastTransitionReason: decision.reason
          }
        });
        return this.snapshot();
      }
      cadeState = "RESUMING";
      decision = { action: "RESUME", leftPwm: NOMINAL_PWM, rightPwm: NOMINAL_PWM, reason: "All relevant obstacles clear for at least 1 second; resuming route.", relevantTrackIds: [], clearForMs };
      this.addEvent("info", `CADE decision RESUME: ${decision.reason}`);
    } else if (cadeState === "RESUMING") {
      cadeState = "CLEAR";
    }

    if (cadeState === "REPLANNING") {
      const replanStart = performance.now();
      const extraBlocks = tracks.filter((track) => track.confidence !== "stale").map((track) => track.lastPosition);
      path = planPath(this.state.robot.pose, this.state.navigation.target, this.state.navigation.world, this.state.navigation.config, extraBlocks);
      waypointIndex = path && path.length > 1 ? 1 : 0;
      const nextRouteFingerprint = pathFingerprint(path);
      const nextTrackFingerprint = trackFingerprint(tracks);
      if (!path) {
        this.replace({
          ...nextState,
          robot: { ...this.state.robot, mode: "stopped" },
          motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
          navigation: {
            ...this.state.navigation,
            obstacles: movedObstacles,
            tracks,
            roverMotion,
            dynamicInteractions,
            adaptiveDecision,
            map: { ...this.state.navigation.map, cells: tracedCells },
            dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
            status: "blocked",
            cadeState: "BLOCKED",
            path: null,
            activeWaypointIndex: 0,
            decision,
            lastTransitionReason: "No safe route after waiting policy expired."
          }
        });
        this.addEvent("warning", "CADE entered BLOCKED: no safe A* route after waiting policy expired.");
        return this.snapshot();
      }
      const unchangedRecoveryRoute =
        nextRouteFingerprint === this.state.navigation.lastReplanRouteFingerprint &&
        nextTrackFingerprint === this.state.navigation.lastReplanTrackFingerprint;
      cadeState = "CLEAR";
      this.addEvent(unchangedRecoveryRoute ? "info" : "warning", unchangedRecoveryRoute ? "CADE revalidated an unchanged recovery route after persistent obstruction." : "CADE replanned after persistent obstruction.");
      this.replace({
        ...nextState,
        robot: { ...this.state.robot, mode: "stopped" },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        navigation: {
          ...this.state.navigation,
          obstacles: movedObstacles,
          tracks,
          roverMotion,
          dynamicInteractions,
          adaptiveDecision,
          map: { ...this.state.navigation.map, cells: tracedCells },
          dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
          replanCount: this.state.navigation.replanCount + (unchangedRecoveryRoute ? 0 : 1),
          lastReplanDurationMs: performance.now() - replanStart,
          lastReplanRouteFingerprint: nextRouteFingerprint,
          lastReplanTrackFingerprint: nextTrackFingerprint,
          decision,
          cadeState: "RESUMING",
          clearSinceMs: now,
          waitStartedMs: null,
          status: "moving",
          path,
          activeWaypointIndex: waypointIndex,
          lastTransitionReason: unchangedRecoveryRoute ? "Persistent obstruction revalidated the existing recovery route; rover held for the next decision cycle." : "Persistent obstruction triggered replan; rover held for the next decision cycle."
        }
      });
      return this.snapshot();
    }

    const waypoint = path[Math.min(waypointIndex, path.length - 1)];
    const nextPose = stepToward(this.state.robot.pose, waypoint, speed, dtSec);
    const collisionRisk = movedObstacles.some(
      (object) => distance(nextPose, object) <= object.radiusCm + this.state.navigation.config.hardClearanceCm
    );
    if (collisionRisk) {
      decision = {
        action: "WAIT",
        leftPwm: 0,
        rightPwm: 0,
        reason: "Proposed rover step would intersect a dynamic obstacle footprint; holding before collision.",
        relevantTrackIds: softRelevantTracks.map((track) => track.id),
        clearForMs: 0
      };
      this.replace({
        ...nextState,
        robot: { ...this.state.robot, mode: "stopped" },
        motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
        navigation: {
          ...this.state.navigation,
          obstacles: movedObstacles,
          tracks,
          roverMotion,
          dynamicInteractions,
          adaptiveDecision,
          map: { ...this.state.navigation.map, cells: tracedCells },
          dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
          cadeState: "WAITING",
          status: "moving",
          waitStartedMs: this.state.navigation.waitStartedMs ?? now,
          clearSinceMs: null,
          decision,
          path,
          activeWaypointIndex: waypointIndex,
          lastTransitionReason: decision.reason
        }
      });
      return this.snapshot();
    }
    if (Math.hypot(nextPose.xCm - waypoint.xCm, nextPose.yCm - waypoint.yCm) < 1 && waypointIndex < path.length - 1) {
      waypointIndex += 1;
    }

    const reached = Math.hypot(nextPose.xCm - this.state.navigation.target.xCm, nextPose.yCm - this.state.navigation.target.yCm) <= this.state.navigation.config.goalToleranceCm;
    const navigationBase = nextState.navigation ?? this.state.navigation;
    nextState = {
      ...nextState,
      robot: { ...this.state.robot, pose: nextPose, mode: reached ? "idle" : "autonomous" },
      motors: { leftAppliedPwm: reached ? 0 : decision.leftPwm, rightAppliedPwm: reached ? 0 : decision.rightPwm },
      navigation: {
        ...navigationBase,
        obstacles: movedObstacles,
        tracks,
        roverMotion,
        dynamicInteractions,
        adaptiveDecision,
        map: { ...this.state.navigation.map, cells: tracedCells },
        dynamicMap: { resolutionCm: this.state.navigation.world.gridCellCm, cells: dynamicCells },
        trajectory: [...this.state.navigation.trajectory, { xCm: nextPose.xCm, yCm: nextPose.yCm }].slice(-500),
        status: reached ? "reached" : "moving",
        cadeState: reached ? "GOAL_REACHED" : cadeState,
        clearSinceMs: reached || cadeState === "CLEAR" ? null : this.state.navigation.clearSinceMs,
        waitStartedMs: reached || cadeState === "CLEAR" || cadeState === "CAUTION" || cadeState === "RESUMING" ? null : this.state.navigation.waitStartedMs,
        decision: reached ? { action: "GOAL_REACHED", leftPwm: 0, rightPwm: 0, reason: "Goal reached.", relevantTrackIds: [], clearForMs: decision.clearForMs } : decision,
        lastTransitionReason: reached ? "Goal reached." : `CADE state ${cadeState}; speed ${speed} cm/s.`,
        path,
        activeWaypointIndex: waypointIndex
      }
    };
    this.replace(nextState);
    if (reached) this.addEvent("info", "Navigation target reached; rover output set to zero.");
    return this.snapshot();
  }

  applyLayout(request: LayoutRequest): RobotState {
    const nextWorld = { ...request.world, version: this.state.navigation.world.version + 1, validationErrors: [] };
    const validationErrors = validateWorld(nextWorld, this.state.navigation.config);
    if (validationErrors.length > 0) {
      this.replace({ navigation: { ...this.state.navigation, world: { ...nextWorld, validationErrors } } });
      this.addEvent("warning", `Static layout rejected: ${validationErrors[0]}`);
      return this.snapshot();
    }
    const staticCells = staticMapCells(nextWorld);
    this.replace({
      robot: { ...this.state.robot, pose: { ...nextWorld.roverStart, valid: true }, mode: "idle" },
      motors: { leftAppliedPwm: 0, rightAppliedPwm: 0 },
      navigation: {
        ...this.state.navigation,
        world: nextWorld,
        target: nextWorld.target,
        path: null,
        activeWaypointIndex: 0,
        status: nextWorld.target ? "target-set" : "idle",
        cadeState: "CLEAR",
        lastTransitionReason: "Static layout applied; stale path invalidated.",
        map: { resolutionCm: nextWorld.gridCellCm, cells: staticCells },
        staticMap: { resolutionCm: nextWorld.gridCellCm, cells: staticCells },
        dynamicMap: { resolutionCm: nextWorld.gridCellCm, cells: [] },
        trajectory: [{ xCm: nextWorld.roverStart.xCm, yCm: nextWorld.roverStart.yCm }],
        tracks: [],
        roverMotion: { lastPosition: null, previousPosition: null, lastObservedMs: null, previousObservedMs: null, velocity: null, velocityStatus: "unavailable" },
        dynamicInteractions: [],
        lastReplanRouteFingerprint: null,
        lastReplanTrackFingerprint: null
      }
    });
    this.addEvent("info", "Static layout applied. Existing path invalidated.");
    return this.snapshot();
  }

  updateNavigationConfig(request: NavigationConfigRequest): RobotState {
    const nextConfig = { ...this.state.navigation.config, ...request.config };
    const invalid =
      nextConfig.nominalSpeedCmPerSec <= 0 ||
      nextConfig.cautionSpeedCmPerSec <= 0 ||
      nextConfig.cautionSpeedCmPerSec > nextConfig.nominalSpeedCmPerSec ||
      nextConfig.hardClearanceCm <= 0 ||
      nextConfig.softClearanceCm < nextConfig.hardClearanceCm ||
      nextConfig.adaptiveStopHorizonSec <= 0 ||
      nextConfig.energyCostWeight < 0 ||
      nextConfig.timeCostWeight < 0 ||
      nextConfig.actionSwitchMargin < 0;
    if (invalid) {
      this.addEvent("warning", "Navigation config rejected: speeds, clearance limits, and the adaptive stop horizon must be positive; cost weights and switching margin cannot be negative.");
      return this.snapshot();
    }
    this.replace({
      navigation: {
        ...this.state.navigation,
        config: nextConfig,
        path: null,
        status: this.state.navigation.target ? "target-set" : "idle",
        lastTransitionReason: "Navigation config changed; stale path invalidated."
      }
    });
    return this.snapshot();
  }

  addEvent(level: DiagnosticEvent["level"], message: string): DiagnosticEvent {
    const event: DiagnosticEvent = {
      id: `evt-${this.clock.now()}-${this.state.diagnostics.recentEvents.length + 1}`,
      level,
      message,
      timestampMs: this.clock.now()
    };
    this.replace({
      diagnostics: {
        ...this.state.diagnostics,
        recentEvents: [event, ...this.state.diagnostics.recentEvents].slice(0, MAX_EVENTS)
      }
    });
    return event;
  }

  private baseline(): RobotState {
    const now = this.clock.now();
    return {
      schemaVersion: 1,
      sequence: 0,
      timestampMs: now,
      transport: {
        type: this.transportType,
        connected: true,
        status: "idle",
        notice: STUB_NOTICE
      },
      robot: {
        mode: "idle",
        pose: { xCm: 0, yCm: 0, thetaDeg: 0, valid: true },
        emergencyStopLatched: false
      },
      encoders: {
        leftPulses: 0,
        rightPulses: 0
      },
      ultrasonic: zeroSensors(),
      motors: {
        leftAppliedPwm: 0,
        rightAppliedPwm: 0
      },
      battery: {
        voltage: 7.4,
        valid: true,
        capacityJoules: TEST_BATTERY_CAPACITY_JOULES,
        remainingJoules: TEST_BATTERY_CAPACITY_JOULES,
        usedJoules: 0,
        percent: 100
      },
      navigation: {
        status: "idle",
        cadeState: "CLEAR",
        lastTransitionReason: "Baseline state.",
        waitStartedMs: null,
        clearSinceMs: null,
        replanCount: 0,
        lastReplanDurationMs: null,
        lastReplanRouteFingerprint: null,
        lastReplanTrackFingerprint: null,
        decision: defaultDecision(),
        decisionLog: [],
        activeRun: null,
        runHistory: [],
        recording: null,
        lastRecording: null,
        adaptiveDecision: defaultAdaptiveDecision(),
        target: null,
        path: null,
        activeWaypointIndex: 0,
        map: {
          resolutionCm: 10,
          cells: []
        },
        staticMap: {
          resolutionCm: 10,
          cells: staticMapCells(defaultWorld())
        },
        dynamicMap: {
          resolutionCm: 10,
          cells: []
        },
        trajectory: [{ xCm: 0, yCm: 0 }],
        obstacles: [],
        tracks: [],
        roverMotion: { lastPosition: null, previousPosition: null, lastObservedMs: null, previousObservedMs: null, velocity: null, velocityStatus: "unavailable" },
        dynamicInteractions: [],
        config: DEFAULT_NAV_CONFIG,
        world: defaultWorld(),
        rayTraceEnabled: true,
        fixtureMap: false
      },
      telemetry: {
        sequence: 0,
        lastUpdateMs: now,
        stale: false,
        valid: true
      },
      diagnostics: {
        latestCommand: null,
        recentEvents: [],
        commandHistory: []
      }
    };
  }

  private replace(patch: Partial<RobotState>): void {
    const next = structuredClone({
      ...this.state,
      ...patch,
      sequence: this.state.sequence + 1,
      timestampMs: this.clock.now()
    });
    const previousDecision = this.state.navigation.decision;
    const nextDecision = next.navigation.decision;
    const decisionChanged =
      previousDecision.action !== nextDecision.action ||
      previousDecision.leftPwm !== nextDecision.leftPwm ||
      previousDecision.rightPwm !== nextDecision.rightPwm ||
      (previousDecision.reason !== nextDecision.reason && !(nextDecision.action === "VERIFY_CLEAR" && previousDecision.action === "VERIFY_CLEAR"));
    if (decisionChanged) {
      const pose = next.robot.pose;
      next.navigation.decisionLog = [
        {
          id: `decision-${next.timestampMs}-${next.sequence}`,
          timestampMs: next.timestampMs,
          pose: { xCm: pose.xCm, yCm: pose.yCm, thetaDeg: pose.thetaDeg },
          action: nextDecision.action,
          leftPwm: nextDecision.leftPwm,
          rightPwm: nextDecision.rightPwm,
          reason: nextDecision.reason,
          report: this.decisionReport(next, previousDecision)
        },
        ...this.state.navigation.decisionLog
      ].slice(0, 150);
    }
    const activeRun = next.navigation.activeRun;
    if (activeRun && this.state.navigation.status === "moving" && next.navigation.status !== "moving") {
      const outcome = next.navigation.status;
      if (outcome === "reached" || outcome === "blocked" || outcome === "stopped") {
        const points = [activeRun.startPose, ...next.navigation.trajectory.slice(activeRun.trajectoryStartIndex)];
        const distanceCm = points.slice(1).reduce((total, point, index) => total + Math.hypot(point.xCm - points[index].xCm, point.yCm - points[index].yCm), 0);
        const summary = {
          ...activeRun,
          endedAtMs: next.timestampMs,
          outcome,
          endPose: { xCm: next.robot.pose.xCm, yCm: next.robot.pose.yCm, thetaDeg: next.robot.pose.thetaDeg },
          energyEndJoules: next.battery.remainingJoules,
          energyUsedJoules: Math.max(0, activeRun.startBatteryJoules - next.battery.remainingJoules),
          durationSec: Math.max(0, (next.timestampMs - activeRun.startedAtMs) / 1000),
          distanceCm,
          replanCount: next.navigation.replanCount,
          decisionCount: next.navigation.decisionLog.filter((entry) => entry.timestampMs >= activeRun.startedAtMs).length,
          finalReason: next.navigation.lastTransitionReason
        };
        next.navigation.activeRun = null;
        next.navigation.runHistory = [summary, ...next.navigation.runHistory].slice(0, 50);
      }
    }
    this.state = next;
  }

  private decisionReport(state: RobotState, previousDecision: RobotState["navigation"]["decision"]): CadeDecisionReport {
    const decision = state.navigation.decision;
    const adaptive = state.navigation.adaptiveDecision;
    const interactions = state.navigation.dynamicInteractions;
    const relevant = interactions.filter((interaction) => decision.relevantTrackIds.includes(interaction.trackId));
    const conflictCount = relevant.filter((interaction) => interaction.routeConflict || interaction.collisionTimeSec !== null).length;
    const hardStop = decision.action === "WAIT" || decision.action === "REPLAN" || decision.action === "BLOCKED";
    const selectedCost = adaptive.costEstimates.find((cost) => cost.action === adaptive.action);
    const alternatives: CadeDecisionReport["alternatives"] = adaptive.costEstimates.map((cost) => ({
      action: cost.action,
      status: cost.action === adaptive.action ? "selected" as const : !cost.available ? "deferred" as const : "rejected" as const,
      reason: cost.action === adaptive.action
        ? "Selected by the adaptive evaluator after safety checks."
        : !cost.available
          ? cost.assumptions
          : "Not selected because it was less suitable than the safe selected action under the current evidence.",
      energyJoules: cost.energyJoules,
      expectedTimeSec: cost.expectedTimeSec
    }));
    if (!alternatives.some((option) => option.status === "selected")) {
      alternatives.unshift({
        action: decision.action,
        status: "selected",
        reason: "Selected by the authoritative CADE safety and route-execution state machine.",
        energyJoules: selectedCost?.energyJoules ?? null,
        expectedTimeSec: selectedCost?.expectedTimeSec ?? null
      });
    }
    const safetyAssessment = hardStop
      ? `${decision.action} was selected because continuing would violate the active safety policy or leave insufficient clearance.`
      : relevant.length > 0
        ? `${decision.action} was selected with ${relevant.length} relevant tracked object(s); ${conflictCount} create a predicted route or collision conflict.`
        : "No active hard-boundary or predicted collision hazard required a stop.";
    const avoidanceAssessment = decision.action === "REPLAN"
      ? "A* recovery was requested because the obstruction persisted long enough that waiting was no longer an effective avoidance strategy."
      : decision.action === "WAIT"
        ? "The rover holds position rather than entering the hard boundary; obstacle motion and clearance continue to be observed."
        : decision.action === "MOVE_CAUTION"
          ? "The rover remains outside the hard boundary and reduces speed to preserve reaction distance."
          : decision.action === "BLOCKED"
            ? "No collision-free route is currently available, so motion is denied."
            : "The current route remains collision-free under available static and dynamic observations.";
    const efficiencyAssessment = selectedCost?.available
      ? `${adaptive.action} has an estimated ${selectedCost.energyJoules?.toFixed(1)} J and ${selectedCost.expectedTimeSec?.toFixed(1)} s under the test-battery model; safety constraints take priority over this estimate.`
      : "No comparable energy/time estimate was available for the selected action; the active safety policy took priority.";
    const remainingCm = remainingPathDistance(state.navigation.path, state.navigation.activeWaypointIndex, state.robot.pose);
    const goalProgressAssessment = decision.action === "GOAL_REACHED"
      ? "Goal tolerance was reached; motors were set to zero."
      : remainingCm === null
        ? "No active route distance is available until a valid path is planned."
        : `${remainingCm.toFixed(1)} cm of planned route remains; ${hardStop ? "goal progress is paused until safety clears." : "the selected action preserves progress toward the target."}`;
    const transitionExplanation = this.describeDecisionTransition(previousDecision.action, decision.action, state);
    return { strategy: state.navigation.config.strategy, transitionExplanation, safetyAssessment, avoidanceAssessment, efficiencyAssessment, goalProgressAssessment, alternatives };
  }

  private describeDecisionTransition(previous: RobotState["navigation"]["decision"]["action"], next: RobotState["navigation"]["decision"]["action"], state: RobotState): string {
    if (previous === "WAIT" && next === "VERIFY_CLEAR") return "The obstacle is no longer inside the safety boundary, but the rover is deliberately still stationary. It has entered a one-second verification period so a temporary sensor gap cannot cause an unsafe restart.";
    if (previous === "VERIFY_CLEAR" && next === "RESUME") return "The route remained clear for the full one-second verification period. The rover can now resume its existing route because the safety condition that caused the stop has been continuously absent.";
    if (next === "WAIT") return "The rover changed from motion to a safe hold because continuing could enter the hard safety boundary or conflict with a predicted obstacle path. It will keep observing instead of driving through the obstacle.";
    if (next === "REPLAN") return `The obstruction has persisted long enough for the ${state.navigation.config.strategy === "rule-based" ? "fixed 3-second rule" : "CADE recovery policy"} to request a new A* route around it.`;
    if (next === "MOVE_CAUTION") return "The object is inside the soft boundary but outside the hard stop boundary. The rover continues at reduced speed to preserve reaction distance while monitoring the route.";
    if (next === "MOVE_NOMINAL") return "No current static, hard-boundary, or predicted dynamic conflict requires a slower or stopped response, so the rover continues on its planned route.";
    if (next === "GOAL_REACHED") return "The rover reached the configured goal tolerance, so propulsion is set to zero and the run is complete.";
    return `The controller changed from ${previous} to ${next} using the active ${state.navigation.config.strategy === "cade" ? "CADE motion-aware" : "fixed-rule"} navigation policy.`;
  }

  private modeForTransport(status: TransportStatus): RobotMode {
    if (this.state.robot.emergencyStopLatched) return "emergency-stop";
    if (status === "disconnected") return "disconnected";
    if (status === "error") return "error";
    if (status === "stopped") return "stopped";
    if (status === "manual") return "manual";
    return "idle";
  }

  private validTelemetry(sample: TelemetrySample): boolean {
    const numericValues = [
      sample.sequence,
      sample.timestampMs,
      sample.encoders.leftPulses,
      sample.encoders.rightPulses,
      sample.motors.leftAppliedPwm,
      sample.motors.rightAppliedPwm
    ];
    const sensorValues = Object.values(sample.ultrasonic).filter((value): value is number => value !== null);
    const batteryValues = sample.batteryVoltage === null ? [] : [sample.batteryVoltage];
    return [...numericValues, ...sensorValues, ...batteryValues].every((value) => Number.isFinite(value));
  }
}
