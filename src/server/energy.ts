import type { AdaptiveAction, AdaptiveActionCostEstimate, NavigationConfig } from "@/shared/protocol";

/**
 * Deterministic test-battery model. The values are documented simulation
 * assumptions, expressed in joules, rather than measurements from hardware.
 */
export const ENERGY_MODEL = {
  travelJoulesPerCm: 1,
  idleWatts: 2,
  stopStartJoules: 12
} as const;

type CostInput = {
  action: AdaptiveAction;
  distanceCm: number | null;
  speedCmPerSec: number | null;
  waitSec?: number | null;
  stopStartCycles?: number;
};

function unavailable(action: AdaptiveAction, assumptions: string): AdaptiveActionCostEstimate {
  return { action, available: false, energyJoules: null, expectedTimeSec: null, combinedCost: null, assumptions };
}

export function estimateEnergyCost(input: CostInput): AdaptiveActionCostEstimate {
  const stopStartCycles = input.stopStartCycles ?? 0;
  const waitSec = input.waitSec ?? 0;
  const hasTravel = input.distanceCm !== null && input.distanceCm > 0;
  if ((hasTravel && (input.distanceCm === null || input.speedCmPerSec === null || input.distanceCm < 0 || input.speedCmPerSec <= 0)) || !Number.isFinite(waitSec)) {
    return unavailable(input.action, "Required route distance, speed, or bounded wait duration is unavailable.");
  }
  const distanceCm = input.distanceCm ?? 0;
  const speedCmPerSec = input.speedCmPerSec ?? 1;
  const travelSec = distanceCm / speedCmPerSec;
  const energyJoules = distanceCm * ENERGY_MODEL.travelJoulesPerCm + waitSec * ENERGY_MODEL.idleWatts + stopStartCycles * ENERGY_MODEL.stopStartJoules;
  const expectedTimeSec = travelSec + waitSec;
  return {
    action: input.action,
    available: Number.isFinite(energyJoules) && Number.isFinite(expectedTimeSec),
    energyJoules,
    expectedTimeSec,
    combinedCost: energyJoules,
    assumptions: "Deterministic test-battery estimate in joules, based on distance, idle duration, and stop/start count; not a hardware power measurement."
  };
}

export type AdaptiveCostOptions = {
  waitSec?: number | null;
  rerouteDistanceCm?: number | null;
};

function weighted(cost: AdaptiveActionCostEstimate, config: NavigationConfig): AdaptiveActionCostEstimate {
  if (!cost.available || cost.energyJoules === null || cost.expectedTimeSec === null) return cost;
  return { ...cost, combinedCost: cost.energyJoules * config.energyCostWeight + cost.expectedTimeSec * config.timeCostWeight };
}

export function evaluateAdaptiveCosts(remainingRouteDistanceCm: number | null, config: NavigationConfig, options: AdaptiveCostOptions = {}): AdaptiveActionCostEstimate[] {
  const common = {
    distanceCm: remainingRouteDistanceCm,
    stopStartCycles: 0
  };
  return [
    estimateEnergyCost({ action: "CONTINUE", ...common, speedCmPerSec: config.nominalSpeedCmPerSec }),
    estimateEnergyCost({ action: "SLOW", ...common, speedCmPerSec: config.cautionSpeedCmPerSec }),
    options.waitSec === null || options.waitSec === undefined
      ? unavailable("WAIT", "Blockage-clear time is not reliably predicted, so a wait-energy estimate is intentionally unavailable.")
      : estimateEnergyCost({ action: "WAIT", distanceCm: remainingRouteDistanceCm, speedCmPerSec: config.nominalSpeedCmPerSec, waitSec: options.waitSec, stopStartCycles: 1 }),
    options.rerouteDistanceCm === null || options.rerouteDistanceCm === undefined
      ? unavailable("REROUTE", "Alternative route distance is not known until the existing A* planner produces a valid route.")
      : estimateEnergyCost({ action: "REROUTE", distanceCm: options.rerouteDistanceCm, speedCmPerSec: config.nominalSpeedCmPerSec, stopStartCycles: 1 }),
    estimateEnergyCost({ action: "STOP", distanceCm: 0, speedCmPerSec: null, waitSec: 0, stopStartCycles: 1 })
  ].map((cost) => weighted(cost, config));
}

export function cheaperSafeAction(costs: AdaptiveActionCostEstimate[], margin: number): "WAIT" | "REROUTE" | null {
  const wait = costs.find((cost) => cost.action === "WAIT");
  const reroute = costs.find((cost) => cost.action === "REROUTE");
  if (!wait?.available || !reroute?.available || wait.combinedCost === null || reroute.combinedCost === null) return null;
  if (reroute.combinedCost + margin < wait.combinedCost) return "REROUTE";
  return "WAIT";
}

export function estimateMissionEnergyJoules(distanceCm: number, idleSec: number, stopStartCycles: number): number {
  return Math.max(0, distanceCm) * ENERGY_MODEL.travelJoulesPerCm + Math.max(0, idleSec) * ENERGY_MODEL.idleWatts + Math.max(0, stopStartCycles) * ENERGY_MODEL.stopStartJoules;
}
