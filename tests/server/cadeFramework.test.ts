import { ManualClock } from "@/server/clock";
import {
  DEFAULT_NAV_CONFIG,
  createDynamicObject,
  defaultWorld,
  inflatedStaticCells,
  planPath,
  staticObjectCells,
  updateTracks,
  validateCardinalPath,
  validateWorld,
  advanceDynamicObjects,
  assessDynamicInteractions,
  pathFingerprint,
  selectAdaptiveAction,
  trackFingerprint,
  updateRoverMotion
} from "@/server/navigation";
import { RobotStateStore } from "@/server/state";
import { estimateEnergyCost, evaluateAdaptiveCosts } from "@/server/energy";

describe("CADE framework extensions", () => {
  it("maps continuous rectangular obstacles into occupied grid cells", () => {
    const cells = staticObjectCells({ kind: "rect", id: "r1", name: "Rack", xCm: 0, yCm: 0, widthCm: 20, heightCm: 20 }, 10);
    expect(cells.length).toBeGreaterThan(1);
    expect(cells).toContainEqual({ xCm: 0, yCm: 0 });
  });

  it("inflates static occupancy by the configured hard-clearance radius before A* planning", () => {
    const world = defaultWorld();
    world.staticObjects = [{ kind: "cells", id: "single", name: "Single cell", cells: [{ xCm: 0, yCm: 0 }] }];
    const inflated = inflatedStaticCells(world, { ...DEFAULT_NAV_CONFIG, hardClearanceCm: 10 });
    expect(inflated.has("0,0")).toBe(true);
    expect(inflated.has("2,0")).toBe(true);
    expect(inflated.has("0,2")).toBe(true);
    expect(planPath({ xCm: -20, yCm: 0 }, { xCm: 20, yCm: 0 }, world, { ...DEFAULT_NAV_CONFIG, hardClearanceCm: 10 })).not.toContainEqual({ xCm: 0, yCm: 0 });
  });

  it("rejects out-of-bounds static layouts", () => {
    const world = defaultWorld();
    world.staticObjects = [{ kind: "rect", id: "bad", name: "Bad", xCm: 600, yCm: 0, widthCm: 40, heightCm: 40 }];
    expect(validateWorld(world, DEFAULT_NAV_CONFIG).some((error) => error.includes("outside"))).toBe(true);
  });

  it("A* produces cardinal paths with Manhattan geometry", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const path = planPath({ xCm: 0, yCm: 0 }, { xCm: 30, yCm: 20 }, world, DEFAULT_NAV_CONFIG);
    expect(path).not.toBeNull();
    expect(validateCardinalPath(path!, world.gridCellCm)).toBe(true);
  });

  it("plans a static-map rover route to one selected target", () => {
    const store = new RobotStateStore(new ManualClock());
    store.setNavigationTarget({ xCm: 40, yCm: 40 });
    const navigation = store.snapshot().navigation;
    expect(navigation.path).not.toBeNull();
    expect(navigation.target).toEqual(navigation.path?.[navigation.path.length - 1]);
  });

  it("plans a cardinal route to every corner of an unobstructed world", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const corners = [
      { xCm: -world.widthCm / 2, yCm: -world.heightCm / 2 },
      { xCm: -world.widthCm / 2, yCm: world.heightCm / 2 },
      { xCm: world.widthCm / 2, yCm: -world.heightCm / 2 },
      { xCm: world.widthCm / 2, yCm: world.heightCm / 2 }
    ];
    for (const corner of corners) {
      const path = planPath({ xCm: 0, yCm: 0 }, corner, world, DEFAULT_NAV_CONFIG);
      expect(path).not.toBeNull();
      expect(path?.[path.length - 1]).toEqual(corner);
      expect(validateCardinalPath(path!, world.gridCellCm)).toBe(true);
    }
  });

  it("reports when a selected target is outside the navigation world", () => {
    const store = new RobotStateStore(new ManualClock());
    store.setNavigationTarget({ xCm: 600, yCm: 0 });
    const navigation = store.snapshot().navigation;
    expect(navigation.status).toBe("blocked");
    expect(navigation.path).toBeNull();
    expect(navigation.lastTransitionReason).toContain("outside the navigation world");
    expect(navigation.decisionLog[0].report.safetyAssessment).toContain("safety");
    expect(navigation.decisionLog[0].report.alternatives[0].status).toBe("selected");
  });

  it("A* routes around inflated dynamic obstacle blocks", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const config = { ...DEFAULT_NAV_CONFIG, hardClearanceCm: 5, softClearanceCm: 10 };
    const block = { xCm: 0, yCm: 30 };
    const path = planPath({ xCm: 0, yCm: 0 }, { xCm: 0, yCm: 70 }, world, config, [block]);
    expect(path).not.toBeNull();
    const dynamicClearanceCm = Math.max(config.softClearanceCm + world.gridCellCm, config.roverClearanceCm + config.hardClearanceCm);
    expect(path!.slice(1).some((point) => Math.hypot(point.xCm - block.xCm, point.yCm - block.yCm) <= dynamicClearanceCm)).toBe(false);
  });

  it("estimates timestamped rover and obstacle velocity with correct relative-motion signs", () => {
    const roverAtStart = updateRoverMotion({ lastPosition: null, previousPosition: null, lastObservedMs: null, previousObservedMs: null, velocity: null, velocityStatus: "unavailable" }, { xCm: 0, yCm: 0, thetaDeg: 0, valid: true }, 0);
    const rover = updateRoverMotion(roverAtStart, { xCm: 10, yCm: 0, thetaDeg: 0, valid: true }, 1000);
    const first = updateTracks([], [{ sensor: "front", rangeCm: 100, position: { xCm: 100, yCm: 0 }, timestampMs: 0 }], 0, DEFAULT_NAV_CONFIG);
    const tracks = updateTracks(first, [{ sensor: "front", rangeCm: 80, position: { xCm: 90, yCm: 0 }, timestampMs: 1000 }], 1000, DEFAULT_NAV_CONFIG);
    const [assessment] = assessDynamicInteractions(rover, { xCm: 10, yCm: 0, thetaDeg: 0, valid: true }, tracks, [{ xCm: 10, yCm: 0 }, { xCm: 75, yCm: 0 }], 0, DEFAULT_NAV_CONFIG, 1000);
    expect(rover.velocity).toEqual({ vxCmPerSec: 10, vyCmPerSec: 0 });
    expect(tracks[0].rawVelocity).toEqual({ vxCmPerSec: -10, vyCmPerSec: 0 });
    expect(assessment.relativeVelocity).toEqual({ vxCmPerSec: -20, vyCmPerSec: 0 });
    expect(assessment.relativeMotionStatus).toBe("approaching");
    expect(assessment.closestApproachTimeSec).toBeCloseTo(4, 5);
    expect(assessment.collisionTimeSec).toBeCloseTo(3.15, 2);
    expect(assessment.routeConflict).toBe(true);
  });

  it("marks invalid observation intervals and discontinuities as unavailable or degraded", () => {
    const first = updateTracks([], [{ sensor: "front", rangeCm: 20, position: { xCm: 0, yCm: 0 }, timestampMs: 1000 }], 1000, DEFAULT_NAV_CONFIG);
    const invalidInterval = updateTracks(first, [{ sensor: "front", rangeCm: 20, position: { xCm: 5, yCm: 0 }, timestampMs: 1000 }], 1000, DEFAULT_NAV_CONFIG);
    expect(invalidInterval[0].velocityStatus).toBe("unavailable");
    const permissiveGate = { ...DEFAULT_NAV_CONFIG, associationGateCm: 300 };
    const degraded = updateTracks(invalidInterval, [{ sensor: "front", rangeCm: 200, position: { xCm: 210, yCm: 0 }, timestampMs: 2000 }], 2000, permissiveGate);
    expect(degraded[0].velocityStatus).toBe("degraded");
    expect(degraded[0].rawVelocity).toBeNull();
  });

  it("rejects non-finite sensor observations instead of emitting invalid motion data", () => {
    const tracks = updateTracks([], [{ sensor: "front", rangeCm: Number.NaN, position: { xCm: Number.NaN, yCm: 0 }, timestampMs: Number.NaN }], 1000, DEFAULT_NAV_CONFIG);
    expect(tracks).toEqual([]);
  });

  it("does not predict a collision for a receding obstacle with no route conflict", () => {
    const roverAtStart = updateRoverMotion({ lastPosition: null, previousPosition: null, lastObservedMs: null, previousObservedMs: null, velocity: null, velocityStatus: "unavailable" }, { xCm: 0, yCm: 0, thetaDeg: 0, valid: true }, 0);
    const rover = updateRoverMotion(roverAtStart, { xCm: 0, yCm: 0, thetaDeg: 0, valid: true }, 1000);
    const first = updateTracks([], [{ sensor: "front", rangeCm: 30, position: { xCm: 30, yCm: 0 }, timestampMs: 0 }], 0, DEFAULT_NAV_CONFIG);
    const tracks = updateTracks(first, [{ sensor: "front", rangeCm: 60, position: { xCm: 60, yCm: 0 }, timestampMs: 1000 }], 1000, DEFAULT_NAV_CONFIG);
    const [assessment] = assessDynamicInteractions(rover, { xCm: 0, yCm: 0, thetaDeg: 0, valid: true }, tracks, [{ xCm: 0, yCm: 0 }, { xCm: 0, yCm: 100 }], 0, DEFAULT_NAV_CONFIG, 1000);
    expect(assessment.relativeMotionStatus).toBe("receding");
    expect(assessment.collisionTimeSec).toBeNull();
    expect(assessment.routeConflict).toBe(false);
  });

  it("selects explainable adaptive actions without bypassing safety priorities", () => {
    const interaction = {
      trackId: "crossing",
      detectionStatus: "detected" as const,
      velocityStatus: "valid" as const,
      confidence: "moving" as const,
      relativeMotionStatus: "approaching" as const,
      relativePosition: { xCm: 50, yCm: 0 },
      relativeVelocity: { vxCmPerSec: -10, vyCmPerSec: 0 },
      objectSpeedCmPerSec: 10,
      observationAgeMs: 0,
      predictionValid: true,
      limitedByUncertainty: false,
      closestApproachTimeSec: 4,
      closestApproachDistanceCm: 4,
      collisionTimeSec: null,
      routeConflict: true,
      routeConflictTimeSec: 4
    };
    expect(selectAdaptiveAction([interaction], DEFAULT_NAV_CONFIG, null).action).toBe("SLOW");
    expect(selectAdaptiveAction([{ ...interaction, collisionTimeSec: 0.8, routeConflictTimeSec: 0.8 }], DEFAULT_NAV_CONFIG, null)).toMatchObject({ action: "STOP", mandatory: true, severity: "critical" });
    expect(selectAdaptiveAction([interaction], DEFAULT_NAV_CONFIG, DEFAULT_NAV_CONFIG.stuckBeforeReplanMs).action).toBe("REROUTE");
    expect(selectAdaptiveAction([{ ...interaction, predictionValid: false, limitedByUncertainty: true, routeConflict: false, routeConflictTimeSec: null, relativePosition: { xCm: 10, yCm: 0 } }], DEFAULT_NAV_CONFIG, null)).toMatchObject({ action: "WAIT", severity: "uncertain" });
  });

  it("creates stable fingerprints for replan guards and detects material track movement", () => {
    expect(pathFingerprint([{ xCm: 0, yCm: 0 }, { xCm: 0, yCm: 5 }])).toBe("0,0|0,5");
    const track = {
      id: "blocker",
      lastPosition: { xCm: 10, yCm: 10 },
      previousPosition: null,
      lastObservedMs: 0,
      previousObservedMs: null,
      lastSensor: "front" as const,
      lastRangeCm: 10,
      rawVelocity: null,
      classifiedDirection: "none" as const,
      confidence: "stationary" as const,
      observations: 1
    };
    expect(trackFingerprint([track])).toBe("blocker:10,10");
    expect(trackFingerprint([{ ...track, lastPosition: { xCm: 15, yCm: 10 } }])).not.toBe(trackFingerprint([track]));
  });

  it("estimates test-battery energy in joules and leaves unknown wait durations unavailable", () => {
    const cost = estimateEnergyCost({ action: "CONTINUE", distanceCm: 100, speedCmPerSec: 50 });
    expect(cost).toMatchObject({ available: true, energyJoules: 100, expectedTimeSec: 2 });
    expect(cost.assumptions).toContain("joules");
    expect(evaluateAdaptiveCosts(100, DEFAULT_NAV_CONFIG).find((candidate) => candidate.action === "WAIT")).toMatchObject({ available: false, energyJoules: null });
  });

  it("lets the cost-aware selector choose a safe detour over a more expensive bounded wait", () => {
    const movingConflict = {
      trackId: "crossing",
      detectionStatus: "detected" as const,
      velocityStatus: "valid" as const,
      confidence: "moving" as const,
      relativeMotionStatus: "approaching" as const,
      relativePosition: { xCm: 80, yCm: 0 },
      relativeVelocity: { vxCmPerSec: -10, vyCmPerSec: 0 },
      objectSpeedCmPerSec: 10,
      observationAgeMs: 0,
      predictionValid: true,
      limitedByUncertainty: false,
      closestApproachTimeSec: 3,
      closestApproachDistanceCm: 10,
      collisionTimeSec: null,
      routeConflict: true,
      routeConflictTimeSec: 3
    };
    const costAware = selectAdaptiveAction([movingConflict], { ...DEFAULT_NAV_CONFIG, energyPlanningEnabled: true }, null, 100, { rerouteDistanceCm: 50 });
    const adaptiveOnly = selectAdaptiveAction([movingConflict], { ...DEFAULT_NAV_CONFIG, energyPlanningEnabled: false }, null, 100, { rerouteDistanceCm: 50 });
    expect(costAware.action).toBe("REROUTE");
    expect(costAware.costEstimates.find((cost) => cost.action === "REROUTE")?.available).toBe(true);
    expect(adaptiveOnly.action).not.toBe("REROUTE");
  });

  it("dynamic object follows a cardinal route at configured speed", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const object = createDynamicObject(
      { id: "d1", name: "Mover", widthCm: 20, heightCm: 20, start: { xCm: 0, yCm: 0 }, goal: { xCm: 30, yCm: 0 }, speedCmPerSec: 10 },
      world,
      DEFAULT_NAV_CONFIG
    );
    expect(object).not.toBeNull();
    const [advanced] = advanceDynamicObjects([object!], world, 1, { xCm: 200, yCm: 200, thetaDeg: 0, valid: true });
    expect(advanced.xCm).toBe(10);
    expect(advanced.yCm).toBe(0);
    expect(advanced.direction).toBe("east");
  });

  it("reroutes a dynamic object after it has been blocked for three seconds", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const object = createDynamicObject(
      { id: "stuck-mover", name: "Stuck mover", widthCm: 20, heightCm: 20, start: { xCm: 0, yCm: 0 }, goal: { xCm: 100, yCm: 0 }, speedCmPerSec: 10 },
      world,
      DEFAULT_NAV_CONFIG
    );
    expect(object).not.toBeNull();
    const rover = { xCm: 10, yCm: 0, thetaDeg: 0, valid: true };
    const [blocked] = advanceDynamicObjects([object!], world, 1, rover, DEFAULT_NAV_CONFIG, 0);
    expect(blocked.status).toBe("blocked");
    expect(blocked.stuckSinceMs).toBe(0);
    const [stillBlocked] = advanceDynamicObjects([blocked], world, 1, rover, DEFAULT_NAV_CONFIG, 2999);
    expect(stillBlocked.status).toBe("blocked");
    const [rerouted] = advanceDynamicObjects([stillBlocked], world, 1, rover, DEFAULT_NAV_CONFIG, 3000);
    expect(rerouted.status).toBe("moving");
    expect(rerouted.lastReplanMs).toBe(3000);
    expect(rerouted.stuckSinceMs).toBeNull();
    expect(rerouted.route.some((point) => point.yCm !== 0)).toBe(true);
  });

  it("builds a dynamic object route through user-drawn waypoints", () => {
    const world = defaultWorld();
    world.staticObjects = [];
    const object = createDynamicObject(
      {
        id: "drawn-route",
        name: "Drawn route",
        widthCm: 20,
        heightCm: 20,
        start: { xCm: -40, yCm: 0 },
        goal: { xCm: 40, yCm: 40 },
        waypoints: [{ xCm: -40, yCm: 0 }, { xCm: -40, yCm: 40 }, { xCm: 40, yCm: 40 }],
        speedCmPerSec: 10
      },
      world,
      DEFAULT_NAV_CONFIG
    );
    expect(object).not.toBeNull();
    expect(object!.route).toContainEqual({ xCm: -40, yCm: 40 });
    expect(object!.route).toContainEqual({ xCm: 40, yCm: 40 });
  });

  it("creates dynamic objects stopped, then starts, stops, and updates their speed on command", () => {
    const store = new RobotStateStore(new ManualClock());
    store.addDynamicObject({
      id: "controlled-mover",
      name: "Controlled mover",
      widthCm: 20,
      heightCm: 20,
      start: { xCm: -120, yCm: 0 },
      goal: { xCm: -80, yCm: 0 },
      speedCmPerSec: 20
    });
    expect(store.snapshot().navigation.obstacles[0].status).toBe("stopped");
    store.controlDynamicObject("controlled-mover", "start", 35);
    expect(store.snapshot().navigation.obstacles[0]).toMatchObject({ status: "moving", speedCmPerSec: 35 });
    store.controlDynamicObject("controlled-mover", "stop");
    expect(store.snapshot().navigation.obstacles[0].status).toBe("stopped");
  });

  it("keeps dynamic object routes and controls independent and supports deletion", () => {
    const store = new RobotStateStore(new ManualClock());
    for (const id of ["mover-a", "mover-b"]) {
      store.addDynamicObject({ id, name: id, widthCm: 20, heightCm: 20, start: { xCm: id === "mover-a" ? -120 : -120, yCm: id === "mover-a" ? -40 : 40 }, goal: { xCm: 120, yCm: id === "mover-a" ? -40 : 40 }, speedCmPerSec: 20 });
    }
    store.controlDynamicObject("mover-a", "start", 30);
    expect(store.snapshot().navigation.obstacles.find((object) => object.id === "mover-a")?.status).toBe("moving");
    expect(store.snapshot().navigation.obstacles.find((object) => object.id === "mover-b")?.status).toBe("stopped");
    store.controlDynamicObject("mover-a", "delete");
    expect(store.snapshot().navigation.obstacles.map((object) => object.id)).toEqual(["mover-b"]);
  });

  it("stops every dynamic object with one authoritative update", () => {
    const store = new RobotStateStore(new ManualClock());
    for (const id of ["batch-a", "batch-b"]) {
      store.addDynamicObject({ id, name: id, widthCm: 20, heightCm: 20, start: { xCm: -100, yCm: id === "batch-a" ? -40 : 40 }, goal: { xCm: 100, yCm: id === "batch-a" ? -40 : 40 }, speedCmPerSec: 20 });
      store.controlDynamicObject(id, "start", 20);
    }
    store.stopAllDynamicObjects();
    expect(store.snapshot().navigation.obstacles.every((object) => object.status === "stopped")).toBe(true);
  });

  it("stops the rover immediately when a dynamic object is inside the hard boundary", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    store.addDynamicObject({
      id: "hard-boundary-object",
      name: "Hard boundary object",
      widthCm: 10,
      heightCm: 10,
      start: { xCm: 0, yCm: 0 },
      goal: { xCm: 0, yCm: 20 },
      speedCmPerSec: 10
    });
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.reason).toContain("hard boundary");
    expect(store.snapshot().motors).toEqual({ leftAppliedPwm: 0, rightAppliedPwm: 0 });
  });

  it("two observations estimate obstacle velocity without using ground truth", () => {
    const first = updateTracks([], [{ sensor: "front", rangeCm: 40, position: { xCm: 0, yCm: 40 }, timestampMs: 1000 }], 1000, DEFAULT_NAV_CONFIG);
    expect(first[0].rawVelocity).toBeNull();
    const second = updateTracks(first, [{ sensor: "front", rangeCm: 50, position: { xCm: 10, yCm: 40 }, timestampMs: 2000 }], 2000, DEFAULT_NAV_CONFIG);
    expect(second[0].rawVelocity?.vxCmPerSec).toBe(10);
    expect(second[0].classifiedDirection).toBe("east");
  });

  it("layout and speed changes invalidate stale paths", () => {
    const store = new RobotStateStore(new ManualClock());
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    expect(store.snapshot().navigation.path).not.toBeNull();
    store.updateNavigationConfig({ config: { nominalSpeedCmPerSec: 60, cautionSpeedCmPerSec: 25 } });
    expect(store.snapshot().navigation.path).toBeNull();
  });

  it("does not resume until the route is clear for at least one second", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    const internal = store as unknown as { state: ReturnType<RobotStateStore["snapshot"]> };
    internal.state.navigation.tracks = [
      {
        id: "track-blocking",
        lastPosition: { xCm: 0, yCm: 20 },
        previousPosition: null,
        lastObservedMs: clock.now(),
        previousObservedMs: null,
        lastSensor: "front",
        lastRangeCm: 20,
        rawVelocity: null,
        classifiedDirection: "none",
        confidence: "tentative",
        observations: 1
      }
    ];
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.action).toBe("WAIT");

    internal.state.navigation.tracks = [];
    clock.advance(900);
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.action).toBe("VERIFY_CLEAR");

    clock.advance(1100);
    store.advanceNavigation(0.1);
    expect(["RESUME", "MOVE_NOMINAL"]).toContain(store.snapshot().navigation.decision.action);
  });

  it("slows inside soft clearance without stopping", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.updateNavigationConfig({ config: { hardClearanceCm: 5, softClearanceCm: 20 } });
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    const internal = store as unknown as { state: ReturnType<RobotStateStore["snapshot"]> };
    internal.state.navigation.tracks = [
      {
        id: "track-soft",
        lastPosition: { xCm: 25, yCm: 20 },
        previousPosition: null,
        lastObservedMs: clock.now(),
        previousObservedMs: null,
        lastSensor: "front",
        lastRangeCm: 25,
        rawVelocity: null,
        classifiedDirection: "none",
        confidence: "tentative",
        observations: 1
      }
    ];
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.action).toBe("MOVE_CAUTION");
    expect(store.snapshot().motors.leftAppliedPwm).toBe(60);
  });

  it("reroutes after being stuck for more than five seconds", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    const internal = store as unknown as { state: ReturnType<RobotStateStore["snapshot"]> };
    internal.state.navigation.config.trackExpireMs = 10000;
    internal.state.navigation.config.trackStaleMs = 10000;
    internal.state.navigation.waitStartedMs = clock.now();
    internal.state.navigation.tracks = [
      {
        id: "track-stuck",
        lastPosition: { xCm: 0, yCm: 20 },
        previousPosition: null,
        lastObservedMs: clock.now(),
        previousObservedMs: null,
        lastSensor: "front",
        lastRangeCm: 20,
        rawVelocity: null,
        classifiedDirection: "none",
        confidence: "stationary",
        observations: 4
      }
    ];
    clock.advance(5100);
    internal.state.navigation.tracks[0].lastObservedMs = clock.now();
    const beforePose = store.snapshot().robot.pose;
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.replanCount).toBeGreaterThan(0);
    expect(store.snapshot().navigation.decision.action).toBe("REPLAN");
    expect(store.snapshot().robot.pose).toEqual(beforePose);
  });

  it("uses the fixed-rule baseline three-second reroute threshold", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.updateNavigationConfig({ config: { strategy: "rule-based" } });
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    const internal = store as unknown as { state: ReturnType<RobotStateStore["snapshot"]> };
    internal.state.navigation.config.trackExpireMs = 10000;
    internal.state.navigation.config.trackStaleMs = 10000;
    internal.state.navigation.waitStartedMs = clock.now();
    internal.state.navigation.tracks = [{ id: "fixed-rule-block", lastPosition: { xCm: 0, yCm: 20 }, previousPosition: null, lastObservedMs: clock.now(), previousObservedMs: null, lastSensor: "front", lastRangeCm: 20, rawVelocity: null, classifiedDirection: "none", confidence: "stationary", observations: 4 }];
    clock.advance(3100);
    internal.state.navigation.tracks[0].lastObservedMs = clock.now();
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.action).toBe("REPLAN");
  });

  it("stores final energy for a stopped run and replays a recorded dynamic scene from its start", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.addDynamicObject({ id: "recorded", name: "Recorded mover", widthCm: 20, heightCm: 20, start: { xCm: -80, yCm: 40 }, goal: { xCm: 80, yCm: 40 }, speedCmPerSec: 20 });
    store.controlDynamicObject("recorded", "start", 20);
    store.startSceneRecording();
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    clock.advance(1000);
    store.advanceNavigation(1);
    store.stopNavigation();
    expect(store.snapshot().navigation.runHistory[0]).toMatchObject({ outcome: "stopped" });
    expect(store.snapshot().navigation.runHistory[0].energyUsedJoules).toBeGreaterThanOrEqual(0);
    store.stopSceneRecording();
    store.replayRecordedScene();
    const replayed = store.snapshot().navigation.obstacles.find((object) => object.id === "recorded");
    expect(replayed).toMatchObject({ xCm: -80, yCm: 40 });
  });

  it("waits when multiple relevant obstacles are observed", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    store.startNavigation();
    const internal = store as unknown as { state: ReturnType<RobotStateStore["snapshot"]> };
    internal.state.navigation.cadeState = "CAUTION";
    internal.state.navigation.tracks = [
      {
        id: "track-a",
        lastPosition: { xCm: 0, yCm: 20 },
        previousPosition: null,
        lastObservedMs: clock.now(),
        previousObservedMs: null,
        lastSensor: "front",
        lastRangeCm: 20,
        rawVelocity: null,
        classifiedDirection: "none",
        confidence: "tentative",
        observations: 1
      },
      {
        id: "track-b",
        lastPosition: { xCm: 0, yCm: 30 },
        previousPosition: null,
        lastObservedMs: clock.now(),
        previousObservedMs: null,
        lastSensor: "front",
        lastRangeCm: 30,
        rawVelocity: null,
        classifiedDirection: "none",
        confidence: "tentative",
        observations: 1
      }
    ];
    store.advanceNavigation(0.1);
    expect(store.snapshot().navigation.decision.action).toBe("WAIT");
    expect(store.snapshot().motors.leftAppliedPwm).toBe(0);
  });
});
