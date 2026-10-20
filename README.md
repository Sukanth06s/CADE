# CADE Rover Control Center

CADE Rover Control Center is a local, deterministic rover-navigation simulator and control dashboard. It demonstrates grid-based path planning, static-object inflation, dynamic-object awareness, CADE adaptive decisions, a fixed-rule comparison baseline, energy accounting, and repeatable test scenes.

> **Simulation notice:** the current transport is a deterministic stub. It is not Gazebo, ESP32 firmware, hardware telemetry, or a physics simulator. Joule values are documented test-battery estimates for consistent in-app comparisons, not calibrated electrical measurements.

## What It Does

- Plans cardinal A* routes on a configurable static map.
- Inflates static obstacles by the rover clearance and hard-stop envelope before route planning.
- Maintains separate primary navigation, static-object, and dynamic-observation map layers.
- Tracks dynamic objects from simulated sensor detections and reacts with hard-stop, soft-slow, clearance verification, and rerouting behavior.
- Supports multiple independently controlled dynamic objects, drawn routes, individual start/stop/speed/delete controls, and **Stop All**.
- Switches between **CADE adaptive navigation** and an **industry fixed-rule baseline** that waits on an obstacle then reroutes after 3 seconds.
- Uses a 100% test battery that depletes from telemetry/PWM load and can be recharged from the dashboard.
- Creates per-run energy summaries and downloadable JSON reports.
- Records and replays a scene configuration, resetting the rover and dynamic objects to their recorded start positions.

## Architecture

| Area | Responsibility |
| --- | --- |
| `src/app` | Next.js dashboard, map canvas, controls, decision log, run history |
| `src/frontend` | REST and WebSocket client |
| `src/server` | Express API, WebSocket stream, authoritative state, planning, transport, metrics |
| `src/shared` | Protocol contracts and rover configuration |
| `tests/server` | State, planner, transport, validation, and REST API tests |
| `scripts/rmaap-experiments.ts` | Deterministic comparative experiment harness |
| `docs` | RMAAP, Selenium, and JMeter supporting material |

## Prerequisites

- Node.js 20 or newer
- npm

## Install And Run

```bash
npm install
```

Start the backend:

```bash
npm run dev:backend
```

Start the dashboard in another terminal:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

Defaults work for local development:

```bash
CADE_BACKEND_PORT=4000
CADE_ALLOWED_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_BASE=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
```

## Typical Workflow

1. Open **Mapping & Navigation**.
2. Select **CADE adaptive navigation** or the **Industry fixed-rule baseline** at the top of the dashboard.
3. Set a rover target by entering coordinates or choosing **Set Target** and clicking the map.
4. Press **Start**. The rover follows its static-map A* route.
5. Add static obstacles with **Draw Obstacle**, or create dynamic objects with **Draw Dynamic Route**.
6. For a dynamic object, click its start point, optional turning points, and end point on the map. Select **Create Dynamic Object** to attach that draft to the new object.
7. After successful creation, the draft is cleared. The next map click begins a fresh route for the next dynamic object.
8. Use individual controls, or **Stop All**, to control dynamic objects.
9. Review the CADE decision panel, rover decision log, run-energy history, and downloaded run report.

## Safety And Navigation

The map uses centimetres. Its default grid is 5 cm by 5 cm.

- **Static inflation:** A* treats cells inside the rover-clearance plus hard-stop-clearance envelope as unavailable.
- **Soft boundary:** a nearby object slows the rover while retaining reaction distance.
- **Hard boundary:** an object entering the hard safety envelope stops the rover. The rover does not intentionally drive through it.
- **Clearance verification:** after hazards leave, the rover holds for one continuous second before resuming.
- **Persistent obstruction:** CADE can request recovery based on motion evidence; the fixed-rule baseline reroutes after 3 seconds. Dynamic objects also reroute after 3 seconds of being stuck.
- **Multiple/directly approaching objects:** the rover holds until the relevant safety condition clears.

## Energy Model And Runs

The test battery starts at 36,000 J and 100%. The deterministic model uses:

- 2 W idle load
- Up to 18 W additional motor load, scaled by applied PWM

The dashboard reports current battery percentage, used/remaining joules, live energy for the active run, and a **Run Energy History** entry after a run reaches the goal, becomes blocked, or is stopped by the operator. Each completed run records outcome, selected navigation system, duration, distance, replans, decision count, and final energy used.

Use **Recharge Battery** before comparable trials.

## Scene Recording And Replay

In **Mapping & Navigation**, Scene Recording captures the current static map, target, navigation configuration, and dynamic-object routes/speeds/start behavior.

Press **Record Scene** before running a case. Recording finishes automatically when all dynamic objects that were moving at recording start reach their goals, or select **Stop Recording**. **Replay Scene** restores the saved configuration and sends the rover and all dynamic objects back to their recorded starting positions.

## Decision Reports

The Rover Decision Log stores each meaningful decision with timestamp, rover pose, motor PWM, and an explanation of:

- Control-flow transitions, such as `WAIT -> VERIFY_CLEAR -> RESUME`
- Safety and avoidance rationale
- Estimated energy/time in joules and seconds where available
- Alternatives considered and why they were rejected or deferred
- Remaining route progress

Use **Download Run Report** to export JSON with final state, active/completed run information, battery state, decision log, and comparison mode.

## REST API

The backend listens on `http://localhost:4000`; WebSocket state is available at `ws://localhost:4000/ws`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend health |
| `GET` | `/api/robot/state` | Current authoritative state |
| `POST` | `/api/robot/commands` | Manual drive, stop, and emergency commands |
| `GET` | `/api/navigation/status` | Navigation state |
| `POST` | `/api/navigation/target` | Set rover target |
| `POST` | `/api/navigation/start` | Start rover navigation |
| `POST` | `/api/navigation/stop` | Stop rover navigation |
| `POST` | `/api/navigation/dynamic-object` | Create a dynamic object |
| `POST` | `/api/navigation/dynamic-object/control` | Control one dynamic object |
| `POST` | `/api/navigation/dynamic-objects/stop` | Stop all dynamic objects |
| `POST` | `/api/navigation/config` | Update navigation settings or policy |
| `POST` | `/api/layout/apply` | Apply world/static layout |
| `POST` | `/api/battery/refresh` | Recharge the test battery |
| `POST` | `/api/recording/start` | Start scene recording |
| `POST` | `/api/recording/stop` | Stop and save scene recording |
| `POST` | `/api/recording/replay` | Replay the saved scene |
| `GET` | `/api/metrics` | Request and transport metrics |
| `POST` | `/api/diagnostics/stub/scenario` | Apply a deterministic test scenario |

Example target request:

```json
{ "xCm": 50, "yCm": 120 }
```

Example policy request:

```json
{ "config": { "strategy": "rule-based" } }
```

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Run deterministic comparative experiments with:

```bash
npm run experiments:rmaap
```

The experiment result is written to `results/rmaap-results.json`.

## Limitations

- Energy values are repeatable simulator estimates, not hardware-calibrated joules or watt-hours.
- Dynamic collision prediction uses a short-horizon circular envelope; static recovery remains grid-based.
- The deterministic stub does not model motor acceleration, wheel slip, sensor noise, or physical contact.
- ROS, Gazebo, and hardware adapters need explicit coordinate transforms using the convention in `src/shared/roverConfig.ts`.
