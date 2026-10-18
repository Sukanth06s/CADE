import type {
  AdaptiveActionEvaluation,
  CardinalDirection,
  DynamicInteractionAssessment,
  DynamicObjectConfig,
  DynamicObjectState,
  MotionEstimate,
  NavigationConfig,
  ObstacleTrack,
  Pose,
  SensorName,
  StaticObject,
  WorldConfig
} from "@/shared/protocol";
import { cheaperSafeAction, evaluateAdaptiveCosts } from "./energy";

export type Point = { xCm: number; yCm: number };
export type MapCellState = "free" | "occupied" | "dynamic";
export type MapCell = { xCm: number; yCm: number; state: MapCellState };
export type Detection = { sensor: SensorName; rangeCm: number; position: Point; timestampMs: number };

export const MOTION_ESTIMATION = {
  minIntervalMs: 25,
  maxIntervalMs: 1500,
  teleportDistanceCm: 150,
  stationarySpeedCmPerSec: 3,
  predictionHorizonSec: 6,
  minimumRelativeSpeedCmPerSec: 0.5
} as const;

export const DEFAULT_NAV_CONFIG: NavigationConfig = {
  strategy: "cade",
  nominalSpeedCmPerSec: 50,
  cautionSpeedCmPerSec: 20,
  sensorRangeCm: 120,
  associationGateCm: 35,
  trackStaleMs: 1200,
  trackExpireMs: 3500,
  waitBeforeReplanMs: 1000,
  clearanceConfirmationsRequired: 2,
  roverClearanceCm: 12,
  hardClearanceCm: 5,
  softClearanceCm: 10,
  stuckBeforeReplanMs: 5000,
  stationaryBeforeStaticMs: 5000,
  goalToleranceCm: 5,
  adaptivePlanningEnabled: true,
  adaptiveStopHorizonSec: 1.5,
  energyPlanningEnabled: true,
  energyCostWeight: 1,
  timeCostWeight: 0.25,
  actionSwitchMargin: 5
};

export function defaultWorld(): WorldConfig {
  return {
    version: 1,
    widthCm: 1000,
    heightCm: 500,
    gridCellCm: 5,
    roverStart: { xCm: 0, yCm: 0, thetaDeg: 0 },
    target: null,
    validationErrors: [],
    staticObjects: [
      { kind: "rect", id: "rack-a", name: "Server rack A", xCm: 70, yCm: 50, widthCm: 36, heightCm: 36 },
      { kind: "rect", id: "shelf-b", name: "Shelf B", xCm: -50, yCm: 95, widthCm: 32, heightCm: 32 },
      { kind: "cells", id: "restricted-c", name: "Restricted cells", cells: [{ xCm: 20, yCm: -80 }, { xCm: 30, yCm: -80 }, { xCm: 20, yCm: -70 }] }
    ]
  };
}

function key(point: Point, gridCellCm: number): string {
  return `${Math.round(point.xCm / gridCellCm)},${Math.round(point.yCm / gridCellCm)}`;
}

function centerFromKey(cellKey: string, gridCellCm: number): Point {
  const [x, y] = cellKey.split(",").map(Number);
  return { xCm: x * gridCellCm, yCm: y * gridCellCm };
}

export function snap(point: Point, gridCellCm: number): Point {
  return {
    xCm: Math.round(point.xCm / gridCellCm) * gridCellCm,
    yCm: Math.round(point.yCm / gridCellCm) * gridCellCm
  };
}

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.xCm - b.xCm) + Math.abs(a.yCm - b.yCm);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.xCm - b.xCm, a.yCm - b.yCm);
}

export function pathFingerprint(path: Point[] | null): string | null {
  return path ? path.map((point) => `${point.xCm},${point.yCm}`).join("|") : null;
}

export function remainingPathDistance(path: Point[] | null, waypointIndex: number, pose: Point): number | null {
  if (!path || waypointIndex >= path.length) return null;
  let total = 0;
  let previous = pose;
  for (const point of path.slice(Math.max(0, waypointIndex))) {
    total += distance(previous, point);
    previous = point;
  }
  return total;
}

export function trackFingerprint(tracks: ObstacleTrack[]): string {
  return tracks
    .filter((track) => track.confidence !== "expired" && track.confidence !== "stale")
    .map((track) => `${track.id}:${Math.round(track.lastPosition.xCm)},${Math.round(track.lastPosition.yCm)}`)
    .sort()
    .join("|");
}

function estimateVelocity(previousPosition: Point | null, previousTimestampMs: number | null, position: Point, timestampMs: number): { velocity: MotionEstimate["velocity"]; velocityStatus: MotionEstimate["velocityStatus"] } {
  if (!Number.isFinite(position.xCm) || !Number.isFinite(position.yCm) || !Number.isFinite(timestampMs)) {
    return { velocity: null, velocityStatus: "unavailable" };
  }
  if (!previousPosition || previousTimestampMs === null) return { velocity: null, velocityStatus: "unavailable" };
  if (!Number.isFinite(previousPosition.xCm) || !Number.isFinite(previousPosition.yCm) || !Number.isFinite(previousTimestampMs)) {
    return { velocity: null, velocityStatus: "degraded" };
  }
  const intervalMs = timestampMs - previousTimestampMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { velocity: null, velocityStatus: "unavailable" };
  if (intervalMs < MOTION_ESTIMATION.minIntervalMs || intervalMs > MOTION_ESTIMATION.maxIntervalMs || distance(previousPosition, position) > MOTION_ESTIMATION.teleportDistanceCm) {
    return { velocity: null, velocityStatus: "degraded" };
  }
  const dtSec = intervalMs / 1000;
  return {
    velocity: {
      vxCmPerSec: (position.xCm - previousPosition.xCm) / dtSec,
      vyCmPerSec: (position.yCm - previousPosition.yCm) / dtSec
    },
    velocityStatus: "valid"
  };
}

export function updateRoverMotion(previous: MotionEstimate, pose: Pose, timestampMs: number): MotionEstimate {
  const position = { xCm: pose.xCm, yCm: pose.yCm };
  const estimate = estimateVelocity(previous.lastPosition, previous.lastObservedMs, position, timestampMs);
  return {
    lastPosition: position,
    previousPosition: previous.lastPosition,
    lastObservedMs: timestampMs,
    previousObservedMs: previous.lastObservedMs,
    velocity: estimate.velocity,
    velocityStatus: estimate.velocityStatus
  };
}

export function assessDynamicInteractions(rover: MotionEstimate, roverPose: Pose, tracks: ObstacleTrack[], path: Point[] | null, waypointIndex: number, config: NavigationConfig, nowMs: number): DynamicInteractionAssessment[] {
  const roverVelocity = rover.velocityStatus === "valid" ? rover.velocity : null;
  const effectiveRadiusCm = config.roverClearanceCm + config.hardClearanceCm;
  return tracks
    .filter((track) => Number.isFinite(track.lastPosition.xCm) && Number.isFinite(track.lastPosition.yCm) && Number.isFinite(track.lastObservedMs))
    .map((track) => {
    const relativePosition = { xCm: track.lastPosition.xCm - roverPose.xCm, yCm: track.lastPosition.yCm - roverPose.yCm };
    const observationAgeMs = Math.max(0, nowMs - track.lastObservedMs);
    const detectionStatus = track.detectionStatus ?? "detected";
    const velocityStatus = track.velocityStatus ?? (track.rawVelocity ? "valid" : "unavailable");
    const predictionValid = detectionStatus === "detected" && velocityStatus === "valid" && roverVelocity !== null && track.rawVelocity !== null;
    const relativeVelocity = predictionValid && track.rawVelocity && roverVelocity
      ? { vxCmPerSec: track.rawVelocity.vxCmPerSec - roverVelocity.vxCmPerSec, vyCmPerSec: track.rawVelocity.vyCmPerSec - roverVelocity.vyCmPerSec }
      : null;
    const dot = relativeVelocity ? relativePosition.xCm * relativeVelocity.vxCmPerSec + relativePosition.yCm * relativeVelocity.vyCmPerSec : 0;
    const relativeSpeedSquared = relativeVelocity ? relativeVelocity.vxCmPerSec ** 2 + relativeVelocity.vyCmPerSec ** 2 : 0;
    const separationCm = Math.hypot(relativePosition.xCm, relativePosition.yCm);
    const radialVelocityCmPerSec = relativeVelocity && separationCm > 0 ? dot / separationCm : null;
    const relativeMotionStatus = !relativeVelocity || radialVelocityCmPerSec === null || relativeSpeedSquared < MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ** 2
      ? "indeterminate" as const
      : radialVelocityCmPerSec < -MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ? "approaching" as const
        : radialVelocityCmPerSec > MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ? "receding" as const
          : "maintaining-separation" as const;
    const closestApproachTimeSec = relativeVelocity && relativeSpeedSquared >= MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ** 2
      ? Math.max(0, Math.min(MOTION_ESTIMATION.predictionHorizonSec, -dot / relativeSpeedSquared))
      : null;
    const closestApproachDistanceCm = closestApproachTimeSec !== null && relativeVelocity
      ? Math.hypot(relativePosition.xCm + relativeVelocity.vxCmPerSec * closestApproachTimeSec, relativePosition.yCm + relativeVelocity.vyCmPerSec * closestApproachTimeSec)
      : null;
    let collisionTimeSec: number | null = null;
    if (predictionValid && relativeVelocity) {
      const a = relativeSpeedSquared;
      const b = 2 * dot;
      const c = relativePosition.xCm ** 2 + relativePosition.yCm ** 2 - effectiveRadiusCm ** 2;
      if (c <= 0) collisionTimeSec = 0;
      else {
        const discriminant = b ** 2 - 4 * a * c;
        if (a >= MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ** 2 && discriminant >= 0) {
          const roots = [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)]
            .filter((time) => time >= 0 && time <= MOTION_ESTIMATION.predictionHorizonSec)
            .sort((left, right) => left - right);
          collisionTimeSec = roots[0] ?? null;
        }
      }
    }
    let routeConflictTimeSec: number | null = null;
    if (predictionValid && track.rawVelocity && path) {
      let travelCm = 0;
      let previousPoint: Point = { xCm: roverPose.xCm, yCm: roverPose.yCm };
      for (const point of path.slice(Math.max(0, waypointIndex), waypointIndex + 80)) {
        const segmentLengthCm = distance(previousPoint, point);
        if (segmentLengthCm === 0) continue;
        const segmentStartSec = travelCm / config.nominalSpeedCmPerSec;
        if (segmentStartSec > MOTION_ESTIMATION.predictionHorizonSec) break;
        const segmentDurationSec = Math.min(segmentLengthCm / config.nominalSpeedCmPerSec, MOTION_ESTIMATION.predictionHorizonSec - segmentStartSec);
        const roverSegmentVelocity = {
          vxCmPerSec: ((point.xCm - previousPoint.xCm) / segmentLengthCm) * config.nominalSpeedCmPerSec,
          vyCmPerSec: ((point.yCm - previousPoint.yCm) / segmentLengthCm) * config.nominalSpeedCmPerSec
        };
        const objectAtSegmentStart = {
          xCm: track.lastPosition.xCm + track.rawVelocity.vxCmPerSec * segmentStartSec,
          yCm: track.lastPosition.yCm + track.rawVelocity.vyCmPerSec * segmentStartSec
        };
        const segmentRelativePosition = {
          xCm: objectAtSegmentStart.xCm - previousPoint.xCm,
          yCm: objectAtSegmentStart.yCm - previousPoint.yCm
        };
        const segmentRelativeVelocity = {
          vxCmPerSec: track.rawVelocity.vxCmPerSec - roverSegmentVelocity.vxCmPerSec,
          vyCmPerSec: track.rawVelocity.vyCmPerSec - roverSegmentVelocity.vyCmPerSec
        };
        const segmentRelativeSpeedSquared = segmentRelativeVelocity.vxCmPerSec ** 2 + segmentRelativeVelocity.vyCmPerSec ** 2;
        const segmentDot = segmentRelativePosition.xCm * segmentRelativeVelocity.vxCmPerSec + segmentRelativePosition.yCm * segmentRelativeVelocity.vyCmPerSec;
        const closestTimeOnSegmentSec = segmentRelativeSpeedSquared >= MOTION_ESTIMATION.minimumRelativeSpeedCmPerSec ** 2
          ? Math.max(0, Math.min(segmentDurationSec, -segmentDot / segmentRelativeSpeedSquared))
          : 0;
        const closestDistanceOnSegmentCm = Math.hypot(
          segmentRelativePosition.xCm + segmentRelativeVelocity.vxCmPerSec * closestTimeOnSegmentSec,
          segmentRelativePosition.yCm + segmentRelativeVelocity.vyCmPerSec * closestTimeOnSegmentSec
        );
        if (closestDistanceOnSegmentCm <= effectiveRadiusCm) {
          routeConflictTimeSec = segmentStartSec + closestTimeOnSegmentSec;
          break;
        }
        travelCm += segmentLengthCm;
        previousPoint = point;
      }
    }
    return {
      trackId: track.id,
      detectionStatus,
      velocityStatus,
      confidence: track.confidence,
      relativeMotionStatus,
      relativePosition,
      relativeVelocity,
      objectSpeedCmPerSec: track.rawVelocity ? Math.hypot(track.rawVelocity.vxCmPerSec, track.rawVelocity.vyCmPerSec) : null,
      observationAgeMs,
      predictionValid,
      limitedByUncertainty: !predictionValid,
      closestApproachTimeSec,
      closestApproachDistanceCm,
      collisionTimeSec,
      routeConflict: routeConflictTimeSec !== null,
      routeConflictTimeSec
    };
  });
}

export function selectAdaptiveAction(
  interactions: DynamicInteractionAssessment[],
  config: NavigationConfig,
  waitForMs: number | null,
  remainingRouteDistanceCm: number | null = null,
  options: { rerouteDistanceCm?: number | null } = {}
): AdaptiveActionEvaluation {
  const conflicts = interactions.filter((interaction) =>
    interaction.routeConflict ||
    (interaction.collisionTimeSec !== null && (interaction.objectSpeedCmPerSec ?? 0) > MOTION_ESTIMATION.stationarySpeedCmPerSec)
  );
  const relevantTrackIds = conflicts.map((interaction) => interaction.trackId);
  const mostUrgent = conflicts
    .slice()
    .sort((left, right) => (left.collisionTimeSec ?? left.routeConflictTimeSec ?? Infinity) - (right.collisionTimeSec ?? right.routeConflictTimeSec ?? Infinity))[0];
  const unknownNearRoute = interactions.filter((interaction) =>
    interaction.limitedByUncertainty && Math.hypot(interaction.relativePosition.xCm, interaction.relativePosition.yCm) <= config.roverClearanceCm + config.softClearanceCm
  );
  const unknownHardRisk = unknownNearRoute.filter((interaction) =>
    interaction.confidence !== "stationary" || Math.hypot(interaction.relativePosition.xCm, interaction.relativePosition.yCm) <= config.roverClearanceCm + config.hardClearanceCm
  );
  const details = mostUrgent ?? unknownNearRoute[0];
  const earliestConflictSec = mostUrgent?.collisionTimeSec ?? mostUrgent?.routeConflictTimeSec ?? null;
  const estimatedBlockageMs = mostUrgent?.predictionValid && (mostUrgent.objectSpeedCmPerSec ?? 0) > MOTION_ESTIMATION.stationarySpeedCmPerSec && earliestConflictSec !== null
    ? Math.max(1000, Math.min(4000, Math.round((earliestConflictSec + 1) * 1000)))
    : null;
  const costEstimates = config.energyPlanningEnabled
    ? evaluateAdaptiveCosts(remainingRouteDistanceCm, config, { waitSec: estimatedBlockageMs === null ? null : estimatedBlockageMs / 1000, rerouteDistanceCm: options.rerouteDistanceCm })
    : [];
  const base = {
    relevantTrackIds: relevantTrackIds.length > 0 ? relevantTrackIds : unknownNearRoute.map((interaction) => interaction.trackId),
    predictionValid: Boolean(mostUrgent?.predictionValid),
    closestApproachTimeSec: details?.closestApproachTimeSec ?? null,
    collisionTimeSec: details?.collisionTimeSec ?? null,
    routeConflictTimeSec: details?.routeConflictTimeSec ?? null,
    estimatedBlockageMs,
    limitedByUncertainty: Boolean(details?.limitedByUncertainty),
    costEstimates
  };

  if (config.strategy === "rule-based" || !config.adaptivePlanningEnabled) {
    return { action: "NO_CHANGE", reason: "Fixed-rule navigation is active: hold for obstacles, then reroute after a persistent 3-second blockage.", severity: "none", mandatory: false, ...base };
  }
  if (unknownHardRisk.length > 0) {
    return { action: "WAIT", reason: "Motion estimate is unavailable near the rover safety envelope; waiting conservatively for observed clearance.", severity: "uncertain", mandatory: false, ...base };
  }
  if (!mostUrgent) {
    return { action: "CONTINUE", reason: "No predicted dynamic interaction affects the current route horizon.", severity: "none", mandatory: false, ...base };
  }
  const movingObject = (mostUrgent.objectSpeedCmPerSec ?? 0) > MOTION_ESTIMATION.stationarySpeedCmPerSec;
  if (!movingObject) {
    return { action: "NO_CHANGE", reason: "Stationary route blockage is delegated to CADE's observed hard-boundary and five-second A* recovery policy.", severity: "blocking", mandatory: false, ...base };
  }
  const imminentConflictSec = mostUrgent.collisionTimeSec ?? mostUrgent.routeConflictTimeSec ?? Infinity;
  if (mostUrgent.collisionTimeSec !== null && imminentConflictSec <= config.adaptiveStopHorizonSec) {
    return { action: "STOP", reason: `Predicted collision with ${mostUrgent.trackId} in ${imminentConflictSec.toFixed(2)} s; holding before the hard safety boundary is entered.`, severity: "critical", mandatory: true, ...base };
  }
  if (waitForMs !== null && waitForMs >= config.stuckBeforeReplanMs) {
    return { action: "REROUTE", reason: `Predicted route conflict persisted for ${waitForMs} ms; requesting the existing A* recovery path.`, severity: "blocking", mandatory: false, ...base };
  }
  const costChoice = config.energyPlanningEnabled ? cheaperSafeAction(costEstimates, config.actionSwitchMargin) : null;
  if (costChoice === "REROUTE") {
    return { action: "REROUTE", reason: `A* found a safe detour with a lower estimated energy cost than the predicted ${estimatedBlockageMs} ms wait.`, severity: "blocking", mandatory: false, ...base };
  }
  if (costChoice === "WAIT") {
    return { action: "WAIT", reason: `Predicted temporary blockage is cheaper to wait through than the available A* detour.`, severity: "blocking", mandatory: false, ...base };
  }
  if (imminentConflictSec <= config.adaptiveStopHorizonSec * 2) {
    return { action: "WAIT", reason: `Predicted route conflict with ${mostUrgent.trackId} is imminent; waiting for observed clearance.`, severity: "blocking", mandatory: false, ...base };
  }
  return { action: "SLOW", reason: `Predicted route conflict with ${mostUrgent.trackId}; reducing speed while the existing safety layer continues to observe clearance.`, severity: "caution", mandatory: false, ...base };
}

function inBounds(point: Point, world: WorldConfig): boolean {
  return Math.abs(point.xCm) <= world.widthCm / 2 && Math.abs(point.yCm) <= world.heightCm / 2;
}

export function staticObjectCells(object: StaticObject, gridCellCm: number): Point[] {
  if (object.kind === "cells") return object.cells.map((cell) => snap(cell, gridCellCm));
  const minX = object.xCm - object.widthCm / 2;
  const maxX = object.xCm + object.widthCm / 2;
  const minY = object.yCm - object.heightCm / 2;
  const maxY = object.yCm + object.heightCm / 2;
  const cells: Point[] = [];
  for (let x = Math.floor(minX / gridCellCm) * gridCellCm; x <= Math.ceil(maxX / gridCellCm) * gridCellCm; x += gridCellCm) {
    for (let y = Math.floor(minY / gridCellCm) * gridCellCm; y <= Math.ceil(maxY / gridCellCm) * gridCellCm; y += gridCellCm) {
      if (x + gridCellCm / 2 >= minX && x - gridCellCm / 2 <= maxX && y + gridCellCm / 2 >= minY && y - gridCellCm / 2 <= maxY) {
        cells.push({ xCm: x, yCm: y });
      }
    }
  }
  return cells;
}

export function occupiedStaticCells(world: WorldConfig): Set<string> {
  const occupied = new Set<string>();
  for (const object of world.staticObjects) {
    for (const cell of staticObjectCells(object, world.gridCellCm)) occupied.add(key(cell, world.gridCellCm));
  }
  return occupied;
}

/** Static occupancy dilated by the rover footprint plus configured hard-clearance radius. */
export function inflatedStaticCells(world: WorldConfig, config: NavigationConfig): Set<string> {
  const occupied = occupiedStaticCells(world);
  const inflated = new Set<string>();
  const clearanceCells = Math.ceil((config.roverClearanceCm + config.hardClearanceCm) / world.gridCellCm);
  for (const cellKey of occupied) {
    const center = centerFromKey(cellKey, world.gridCellCm);
    for (let dx = -clearanceCells; dx <= clearanceCells; dx += 1) {
      for (let dy = -clearanceCells; dy <= clearanceCells; dy += 1) {
        const candidate = { xCm: center.xCm + dx * world.gridCellCm, yCm: center.yCm + dy * world.gridCellCm };
        if (inBounds(candidate, world)) inflated.add(key(candidate, world.gridCellCm));
      }
    }
  }
  return inflated;
}

function blocked(point: Point, world: WorldConfig, config: NavigationConfig, extraBlocks: Point[] = [], staticBlocks = inflatedStaticCells(world, config)): boolean {
  if (!inBounds(point, world)) return true;
  const snapped = snap(point, world.gridCellCm);
  if (staticBlocks.has(key(snapped, world.gridCellCm))) return true;
  // Keep recovery A* clearance aligned with RMAAP's swept collision envelope.
  const extraBlockClearanceCm = Math.max(config.softClearanceCm + world.gridCellCm, config.roverClearanceCm + config.hardClearanceCm);
  return extraBlocks.some((block) => distance(snapped, snap(block, world.gridCellCm)) <= extraBlockClearanceCm);
}

function nearestFreeCell(point: Point, world: WorldConfig, config: NavigationConfig, extraBlocks: Point[], staticBlocks: Set<string>): Point | null {
  const snapped = snap(point, world.gridCellCm);
  if (!blocked(snapped, world, config, extraBlocks, staticBlocks)) return snapped;
  const step = world.gridCellCm;
  for (let radius = 1; radius <= 8; radius += 1) {
    const candidates: Point[] = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        candidates.push({ xCm: snapped.xCm + dx * step, yCm: snapped.yCm + dy * step });
      }
    }
    const reachable = candidates
      .filter((candidate) => !blocked(candidate, world, config, extraBlocks, staticBlocks))
      .sort((a, b) => manhattan(a, snapped) - manhattan(b, snapped))[0];
    if (reachable) return reachable;
  }
  return null;
}

function neighbors(point: Point, world: WorldConfig, config: NavigationConfig, extraBlocks: Point[], staticBlocks: Set<string>): Point[] {
  const step = world.gridCellCm;
  return [
    { xCm: point.xCm + step, yCm: point.yCm },
    { xCm: point.xCm - step, yCm: point.yCm },
    { xCm: point.xCm, yCm: point.yCm + step },
    { xCm: point.xCm, yCm: point.yCm - step }
  ].filter((candidate) => !blocked(candidate, world, config, extraBlocks, staticBlocks));
}

export function planPath(start: Point, target: Point, world: WorldConfig, config: NavigationConfig, extraBlocks: Point[] = []): Point[] | null {
  // Inflation is invariant for one A* search. Rebuilding it for every neighbor was
  // the dominant source of multi-second target-planning delays on dense maps.
  const staticBlocks = inflatedStaticCells(world, config);
  const startCell = nearestFreeCell(start, world, config, extraBlocks, staticBlocks);
  const targetCell = nearestFreeCell(target, world, config, extraBlocks, staticBlocks);
  if (!startCell || !targetCell) return null;

  const open = new Set([key(startCell, world.gridCellCm)]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[key(startCell, world.gridCellCm), 0]]);
  const fScore = new Map<string, number>([[key(startCell, world.gridCellCm), manhattan(startCell, targetCell)]]);

  while (open.size > 0) {
    const currentKey = [...open].sort((a, b) => (fScore.get(a) ?? Infinity) - (fScore.get(b) ?? Infinity))[0];
    const current = centerFromKey(currentKey, world.gridCellCm);
    if (currentKey === key(targetCell, world.gridCellCm)) {
      const path = [targetCell];
      let cursor = currentKey;
      while (cameFrom.has(cursor)) {
        cursor = cameFrom.get(cursor)!;
        path.unshift(centerFromKey(cursor, world.gridCellCm));
      }
      return path;
    }

    open.delete(currentKey);
    for (const next of neighbors(current, world, config, extraBlocks, staticBlocks)) {
      const nextKey = key(next, world.gridCellCm);
      const tentativeG = (gScore.get(currentKey) ?? Infinity) + world.gridCellCm;
      if (tentativeG < (gScore.get(nextKey) ?? Infinity)) {
        cameFrom.set(nextKey, currentKey);
        gScore.set(nextKey, tentativeG);
        fScore.set(nextKey, tentativeG + manhattan(next, targetCell));
        open.add(nextKey);
      }
    }
  }
  return null;
}

export function validateWorld(world: WorldConfig, config: NavigationConfig): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(world.widthCm) || world.widthCm < 100 || world.widthCm > 2000) errors.push("World width must be 100-2000 cm.");
  if (!Number.isFinite(world.heightCm) || world.heightCm < 100 || world.heightCm > 2000) errors.push("World height must be 100-2000 cm.");
  if (!Number.isInteger(world.gridCellCm) || world.gridCellCm < 5 || world.gridCellCm > 50) errors.push("Grid cell size must be an integer from 5 to 50 cm.");
  if (blocked(world.roverStart, world, config)) errors.push("Rover start is out of bounds or intersects a static obstacle.");
  if (world.target && blocked(world.target, world, config)) errors.push("Target is out of bounds or intersects a static obstacle.");
  for (const object of world.staticObjects) {
    const cells = staticObjectCells(object, world.gridCellCm);
    if (cells.length === 0) errors.push(`${object.name} occupies no grid cells.`);
    if (cells.some((cell) => !inBounds(cell, world))) errors.push(`${object.name} extends outside the world bounds.`);
  }
  return errors;
}

export function validateCardinalPath(path: Point[], gridCellCm: number): boolean {
  return path.every((point, index) => {
    if (index === 0) return true;
    return manhattan(path[index - 1], point) === gridCellCm;
  });
}

export function createDynamicObject(config: DynamicObjectConfig, world: WorldConfig, navConfig: NavigationConfig, existing: DynamicObjectState[] = []): DynamicObjectState | null {
  const requestedWaypoints = config.waypoints?.length && config.waypoints.length >= 2 ? config.waypoints : [config.start, config.goal];
  const route: Point[] = [];
  for (let index = 1; index < requestedWaypoints.length; index += 1) {
    const segment = planPath(requestedWaypoints[index - 1], requestedWaypoints[index], world, navConfig, existing.map((object) => snap(object, world.gridCellCm)));
    if (!segment) return null;
    route.push(...(index === 1 ? segment : segment.slice(1)));
  }
  if (!route || !validateCardinalPath(route, world.gridCellCm)) return null;
  const start = route[0];
  return {
    ...config,
    start,
    goal: route[route.length - 1],
    waypoints: requestedWaypoints.map((point) => snap(point, world.gridCellCm)),
    xCm: start.xCm,
    yCm: start.yCm,
    route,
    waypointIndex: route.length > 1 ? 1 : 0,
    status: route.length > 1 ? "moving" : "waiting-at-destination",
    direction: "none",
    dynamic: true,
    radiusCm: Math.max(config.widthCm, config.heightCm) / 2,
    stuckSinceMs: null,
    lastReplanMs: null
  };
}

function directionBetween(from: Point, to: Point): CardinalDirection {
  if (to.yCm > from.yCm) return "north";
  if (to.yCm < from.yCm) return "south";
  if (to.xCm > from.xCm) return "east";
  if (to.xCm < from.xCm) return "west";
  return "none";
}

export function advanceDynamicObjects(objects: DynamicObjectState[], world: WorldConfig, dtSec: number, roverPose: Pose, config: NavigationConfig = DEFAULT_NAV_CONFIG, nowMs = Date.now()): DynamicObjectState[] {
  const occupied = new Set<string>();
  return objects.map((object) => {
    if ((object.status !== "moving" && object.status !== "blocked") || object.waypointIndex >= object.route.length) return object;
    const current = { xCm: object.xCm, yCm: object.yCm };
    let activeObject = object;
    const stepCm = activeObject.speedCmPerSec * dtSec;
    let target = activeObject.route[activeObject.waypointIndex];
    let next = current;
    let direction: CardinalDirection = "none";
    let waypointIndex = activeObject.waypointIndex;
    let distanceBudget = stepCm;
    while (distanceBudget > 0 && waypointIndex < activeObject.route.length) {
      target = activeObject.route[waypointIndex];
      const remaining = manhattan(next, target);
      direction = directionBetween(next, target);
      if (remaining > distanceBudget) {
        next = { xCm: next.xCm + Math.sign(target.xCm - next.xCm) * distanceBudget, yCm: next.yCm + Math.sign(target.yCm - next.yCm) * distanceBudget };
        distanceBudget = 0;
      } else {
        next = target;
        distanceBudget -= remaining;
        waypointIndex += 1;
      }
    }
    const nextCell = key(snap(next, world.gridCellCm), world.gridCellCm);
    const collisionWithObject = objects.some((other) => other.id !== object.id && distance(next, other) <= activeObject.radiusCm + other.radiusCm);
    const collisionWithRover = distance(next, roverPose) <= activeObject.radiusCm + config.hardClearanceCm;
    if (occupied.has(nextCell) || collisionWithObject || collisionWithRover) {
      const stuckSinceMs = activeObject.stuckSinceMs ?? nowMs;
      const stuckForMs = nowMs - stuckSinceMs;
      const canRetryReplan = activeObject.lastReplanMs === null || nowMs - activeObject.lastReplanMs >= 1000;
      if (stuckForMs < 3000 || !canRetryReplan) {
        return { ...activeObject, status: "blocked", direction, stuckSinceMs };
      }
      const blockers = objects.filter((other) => other.id !== object.id).map((other) => ({ xCm: other.xCm, yCm: other.yCm }));
      if (collisionWithRover) blockers.push({ xCm: roverPose.xCm, yCm: roverPose.yCm });
      const reroute = planPath({ xCm: activeObject.xCm, yCm: activeObject.yCm }, activeObject.goal, world, config, blockers);
      if (!reroute || reroute.length < 2) return { ...activeObject, status: "blocked", direction, stuckSinceMs, lastReplanMs: nowMs };
      activeObject = { ...activeObject, route: reroute, waypointIndex: 1, status: "moving", stuckSinceMs: null, lastReplanMs: nowMs };
      target = reroute[1];
      const rerouteDirection = directionBetween({ xCm: activeObject.xCm, yCm: activeObject.yCm }, target);
      const rerouteNext = manhattan({ xCm: activeObject.xCm, yCm: activeObject.yCm }, target) <= stepCm
        ? target
        : { xCm: activeObject.xCm + Math.sign(target.xCm - activeObject.xCm) * stepCm, yCm: activeObject.yCm + Math.sign(target.yCm - activeObject.yCm) * stepCm };
      return { ...activeObject, xCm: Number(rerouteNext.xCm.toFixed(3)), yCm: Number(rerouteNext.yCm.toFixed(3)), direction: rerouteDirection };
    }
    occupied.add(nextCell);
    return {
      ...activeObject,
      xCm: Number(next.xCm.toFixed(3)),
      yCm: Number(next.yCm.toFixed(3)),
      waypointIndex,
      direction,
      status: waypointIndex >= activeObject.route.length ? "waiting-at-destination" : "moving",
      stuckSinceMs: null
    };
  });
}

export function pathBlockedByTracks(path: Point[] | null, waypointIndex: number, tracks: ObstacleTrack[], world: WorldConfig, clearanceCm: number): boolean {
  if (!path) return true;
  const relevant = tracks.filter((track) => track.confidence !== "expired" && track.confidence !== "stale");
  return path.slice(Math.max(0, waypointIndex), waypointIndex + 4).some((point) =>
    relevant.some((track) => distance(point, track.lastPosition) <= clearanceCm + world.gridCellCm)
  );
}

export function staticMapCells(world: WorldConfig): Array<{ xCm: number; yCm: number; state: "occupied" }> {
  return [...occupiedStaticCells(world)].map((cellKey) => {
    const [x, y] = cellKey.split(",").map(Number);
    return { xCm: x * world.gridCellCm, yCm: y * world.gridCellCm, state: "occupied" as const };
  });
}

export function dynamicMapCells(dynamicObjects: DynamicObjectState[], tracks: ObstacleTrack[], world: WorldConfig): Array<{ xCm: number; yCm: number; state: "dynamic" | "observed" }> {
  const cells = new Map<string, { xCm: number; yCm: number; state: "dynamic" | "observed" }>();
  for (const object of dynamicObjects) {
    const point = snap(object, world.gridCellCm);
    cells.set(key(point, world.gridCellCm), { ...point, state: "dynamic" });
  }
  for (const track of tracks.filter((track) => track.confidence !== "expired" && track.confidence !== "stale")) {
    const point = snap(track.lastPosition, world.gridCellCm);
    cells.set(key(point, world.gridCellCm), { ...point, state: "observed" });
  }
  return [...cells.values()].slice(-400);
}

export function stepToward(pose: Pose, waypoint: Point, speedCmPerSec: number, dtSec: number): Pose {
  const dx = waypoint.xCm - pose.xCm;
  const dy = waypoint.yCm - pose.yCm;
  const axis: "x" | "y" = Math.abs(dx) > 0 ? "x" : "y";
  const remaining = axis === "x" ? Math.abs(dx) : Math.abs(dy);
  if (remaining === 0) return { ...pose, valid: true };
  const step = Math.min(speedCmPerSec * dtSec, remaining);
  const nextX = axis === "x" ? pose.xCm + Math.sign(dx) * step : pose.xCm;
  const nextY = axis === "y" ? pose.yCm + Math.sign(dy) * step : pose.yCm;
  const thetaDeg = axis === "x" ? (dx > 0 ? -90 : 90) : dy > 0 ? 0 : 180;
  return {
    xCm: Math.abs(nextX - waypoint.xCm) < 0.001 ? waypoint.xCm : Number(nextX.toFixed(3)),
    yCm: Math.abs(nextY - waypoint.yCm) < 0.001 ? waypoint.yCm : Number(nextY.toFixed(3)),
    thetaDeg,
    valid: true
  };
}

export function rayTraceMap(pose: Pose, world: WorldConfig, dynamicObjects: DynamicObjectState[], previous: MapCell[], config: NavigationConfig): MapCell[] {
  const cells = new Map(previous.filter((cell) => cell.state !== "dynamic").map((cell) => [key(cell, world.gridCellCm), cell]));
  const sensorAngles = [45, 0, -45];
  const occupiedStatic = occupiedStaticCells(world);

  for (const relativeAngle of sensorAngles) {
    const angleRad = ((pose.thetaDeg + relativeAngle) * Math.PI) / 180;
    for (let rangeCm = world.gridCellCm; rangeCm <= config.sensorRangeCm; rangeCm += world.gridCellCm) {
      const point = snap({ xCm: pose.xCm - Math.sin(angleRad) * rangeCm, yCm: pose.yCm + Math.cos(angleRad) * rangeCm }, world.gridCellCm);
      const dynamicHit = dynamicObjects.find((object) => distance(point, object) <= object.radiusCm);
      const staticHit = occupiedStatic.has(key(point, world.gridCellCm));
      cells.set(key(point, world.gridCellCm), { ...point, state: dynamicHit ? "dynamic" : staticHit ? "occupied" : "free" });
      if (dynamicHit || staticHit) break;
    }
  }

  for (const cellKey of occupiedStatic) cells.set(cellKey, { ...centerFromKey(cellKey, world.gridCellCm), state: "occupied" });
  for (const object of dynamicObjects) cells.set(key(object, world.gridCellCm), { ...snap(object, world.gridCellCm), state: "dynamic" });
  return [...cells.values()].slice(-900);
}

export function detectionsFromSensors(pose: Pose, world: WorldConfig, dynamicObjects: DynamicObjectState[], config: NavigationConfig): {
  readings: Record<SensorName, number | null>;
  detections: Detection[];
} {
  const readings: Record<SensorName, number | null> = { left: null, front: null, right: null };
  const detections: Detection[] = [];
  const sensors = [["left", 45], ["front", 0], ["right", -45]] as const;
  const occupiedStatic = occupiedStaticCells(world);
  for (const [sensor, relativeAngle] of sensors) {
    const angleRad = ((pose.thetaDeg + relativeAngle) * Math.PI) / 180;
    for (let rangeCm = world.gridCellCm; rangeCm <= config.sensorRangeCm; rangeCm += world.gridCellCm) {
      const point = snap({ xCm: pose.xCm - Math.sin(angleRad) * rangeCm, yCm: pose.yCm + Math.cos(angleRad) * rangeCm }, world.gridCellCm);
      const hit = dynamicObjects.some((object) => distance(point, object) <= object.radiusCm) || occupiedStatic.has(key(point, world.gridCellCm));
      if (hit) {
        readings[sensor] = rangeCm;
        detections.push({ sensor, rangeCm, position: point, timestampMs: 0 });
        break;
      }
    }
  }
  return { readings, detections };
}

export function updateTracks(existing: ObstacleTrack[], detections: Detection[], timestampMs: number, config: NavigationConfig): ObstacleTrack[] {
  const tracks: ObstacleTrack[] = existing.map((track) => {
    const age = timestampMs - track.lastObservedMs;
    const lost = age >= config.trackExpireMs;
    const stale = age >= config.trackStaleMs;
    return {
      ...track,
      confidence: lost ? "expired" : stale ? "stale" : track.confidence,
      detectionStatus: lost ? "lost" : stale ? "stale" : "temporarily-unobserved",
      velocityStatus: lost || stale ? "degraded" : track.velocityStatus
    };
  });

  for (const detection of detections) {
    if (!Number.isFinite(detection.position.xCm) || !Number.isFinite(detection.position.yCm) || !Number.isFinite(detection.timestampMs) || !Number.isFinite(detection.rangeCm)) continue;
    const candidate = tracks
      .filter((track) => track.confidence !== "expired")
      .map((track) => ({ track, gap: distance(track.lastPosition, detection.position) }))
      .filter(({ gap }) => gap <= config.associationGateCm)
      .sort((a, b) => a.gap - b.gap)[0]?.track;

    if (!candidate) {
      tracks.push({
        id: `track-${timestampMs}-${tracks.length + 1}`,
        lastPosition: detection.position,
        previousPosition: null,
        lastObservedMs: timestampMs,
        previousObservedMs: null,
        lastSensor: detection.sensor,
        lastRangeCm: detection.rangeCm,
        rawVelocity: null,
        detectionStatus: "detected",
        velocityStatus: "unavailable",
        classifiedDirection: "none",
        confidence: "tentative",
        observations: 1
      });
      continue;
    }

    const estimate = estimateVelocity(candidate.lastPosition, candidate.lastObservedMs, detection.position, timestampMs);
    const rawVelocity = estimate.velocity;
    const speed = rawVelocity ? Math.hypot(rawVelocity.vxCmPerSec, rawVelocity.vyCmPerSec) : 0;
    Object.assign(candidate, {
      previousPosition: candidate.lastPosition,
      previousObservedMs: candidate.lastObservedMs,
      lastPosition: detection.position,
      lastObservedMs: timestampMs,
      lastSensor: detection.sensor,
      lastRangeCm: detection.rangeCm,
      rawVelocity,
      detectionStatus: "detected",
      velocityStatus: estimate.velocityStatus,
      classifiedDirection: rawVelocity ? classifyVelocity(rawVelocity) : "none",
      confidence: candidate.observations >= 1 ? (speed >= 3 ? "moving" : "stationary") : "tentative",
      observations: candidate.observations + 1
    });
  }

  return tracks.filter((track) => track.confidence !== "expired").slice(-30);
}

function classifyVelocity(velocity: { vxCmPerSec: number; vyCmPerSec: number }): CardinalDirection {
  if (Math.hypot(velocity.vxCmPerSec, velocity.vyCmPerSec) < 3) return "none";
  return Math.abs(velocity.vxCmPerSec) > Math.abs(velocity.vyCmPerSec)
    ? velocity.vxCmPerSec > 0 ? "east" : "west"
    : velocity.vyCmPerSec > 0 ? "north" : "south";
}
