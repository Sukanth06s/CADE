# RMAAP v2 Implementation Guide

## What Changed

CADE now retains time-validated rover and object motion, derives relative position and velocity, estimates closest approach, collision time, and swept route conflicts, then supplies that evidence to a conservative adaptive action selector.

The selector can propose `CONTINUE`, `SLOW`, `WAIT`, `REROUTE`, `STOP`, or `NO_CHANGE`. The existing CADE safety executor remains authoritative: hard-boundary entry stops immediately, a moving-object collision within the stop horizon requests a stop, clearance still requires confirmation, and stationary blockages retain the five-second A* recovery path.

Stationary tracked objects no longer cause indefinite uncertainty waiting at soft-only distance. They are delegated to the physical hard-boundary check and the existing persistent-block recovery, so the rover can make a valid static-aware detour without driving through the object.

## Static Inflation And Dynamic Clearance

`inflatedStaticCells()` rasterizes every static object and expands it by `ceil((roverClearanceCm + hardClearanceCm) / gridCellCm)` cells in both axes. With defaults this is `ceil((12 + 5) / 5) = 4` cells, a conservative 20 cm grid buffer. A* checks that inflated occupancy before creating a route.

Dynamic recovery uses the larger of soft clearance plus one cell and the same rover-plus-hard envelope. This keeps the A* grid and near-term collision envelope aligned. It is deliberately conservative and may make narrow routes infeasible.

## Cost-Aware Decisions

`src/server/energy.ts` exposes a deterministic, replaceable proxy model:

- travel: `1.0` proxy unit/cm
- idle: `2.0` proxy units/s
- stop/start: `12.0` proxy units/cycle

The selector only compares `WAIT` and `REROUTE` when both have valid estimates. Invalid or unknown values stay unavailable, never zero. The selected action must remain safe; energy never overrides a hard stop or clearance rule. Candidate-detour planning is rate-limited to 1 Hz while collision checking remains at the control rate.

## Diagnostics

The Mapping & Navigation panel exposes the RMAAP action, available candidate costs, waiting/blockage duration, CADE state, route recovery status, relative velocity, route-conflict timing, and dynamic-object velocity arrows. Decision logs continue to carry the rover pose and timestamp.

## Run It

1. Start the backend with `npm run dev:backend`.
2. Start the UI with `npm run dev`.
3. In **Mapping & Navigation**, set a target and select **Start**.
4. Add or draw obstacles, then watch **CADE decision** and **RMAAP assessment** together.
5. To compare modes, update navigation config with `adaptivePlanningEnabled` and `energyPlanningEnabled`.
6. Verify code with `npm run typecheck`, `npm test`, and `npm run lint`.
7. Run `npm run experiments:rmaap`. The JSON artifact is `results/rmaap-results.json`.

## Reproducible Experiment

The harness covers clear, crossing, head-on, parallel, temporary block, persistent block, and no-safe-route scenarios across A baseline, B awareness-only, C adaptive, and D cost-aware adaptive configurations. The simulation contains no random input, so the harness records five identical deterministic observations per configuration from one representative execution; this is declared in the script and results artifact.

The current measurements are intentionally not presented as an improvement claim. All reachable scenarios completed with zero collisions, and no-safe-route correctly blocked before motion. Adaptive C/D matched baseline on clear, crossing, parallel, and no-safe-route cases; they were more conservative in head-on (+4.4 s, +20.8 proxy units) and persistent-block (+6.8 s, +23.6 proxy units) cases. D made cost-aware comparisons (34 in head-on and 69 in persistent-block) but selected the same safe behavior as C under the current proxy weights.

## Limitations

- Proxy units are not physical watt-hours. Motor current, voltage, and acceleration calibration are required for an energy claim.
- Collision prediction uses a short-horizon circular envelope; static recovery is grid-based.
- The current policy favors conservatism. Future calibration should tune idle, restart, and time weights against real rover data before expecting efficiency gains.
