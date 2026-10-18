# CADE Rover Control Center

Production-structured local control, telemetry, visualization, diagnostics, and testing application for the CADE Rover.

The current transport is intentionally a deterministic stub. It is test data, not Gazebo, not ESP32 hardware, and not a physics simulation.

## Architecture

- `src/shared`: typed protocol and rover physical configuration.
- `src/server`: Express REST API, WebSocket stream, authoritative robot state, command validation, metrics, transport manager, deterministic stub transport.
- `src/app`: Next.js frontend console with overview, map, manual control, and diagnostics/testing sections.
- `tests/server`: Vitest unit and API tests for validation, state, lifecycle, and REST behaviour.
- `docs/selenium`: Selenium IDE test-case table and procedure.
- `docs/jmeter`: JMeter test plan instructions.

## Install

```bash
npm install
```

## Run

Start the backend:

```bash
npm run dev:backend
```

Start the frontend in another terminal:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment

```bash
CADE_BACKEND_PORT=4000
CADE_ALLOWED_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_BASE=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
```

Defaults match the values above.

## REST API

- `GET /api/health`
- `GET /api/robot/state`
- `POST /api/robot/commands`
- `GET /api/navigation/status`
- `POST /api/navigation/target`
- `POST /api/navigation/start`
- `POST /api/navigation/stop`
- `POST /api/navigation/dynamic-object`
- `POST /api/navigation/config`
- `POST /api/layout/apply`
- `GET /api/metrics`
- `POST /api/diagnostics/stub/scenario`

Drive command example:

```json
{ "type": "drive", "leftPwm": 120, "rightPwm": 120 }
```

Navigation target example:

```json
{ "xCm": 50, "yCm": 120 }
```

Navigation config example:

```json
{ "config": { "nominalSpeedCmPerSec": 50, "cautionSpeedCmPerSec": 20 } }
```

Dynamic object example:

```json
{
  "object": {
    "id": "dyn-1",
    "name": "Cart",
    "widthCm": 22,
    "heightCm": 22,
    "start": { "xCm": -120, "yCm": 70 },
    "goal": { "xCm": 120, "yCm": 70 },
    "speedCmPerSec": 22
  }
}
```

Static layout updates are applied through `POST /api/layout/apply`. Rectangular structures and selected grid-cell regions are converted into one canonical occupied-cell model for path planning.

## CADE Behaviour

- Static layouts are configured manually and validated by the backend.
- A* uses four-connected grid movement with a Manhattan heuristic.
- Rover and dynamic-object motion is cardinal only.
- Dynamic objects use validated start, goal and speed settings and stop at their goal.
- Sensor detections are converted into observed tracks; ground-truth dynamic routes are not exposed to the CADE decision state.
- CADE state distinguishes `CLEAR`, `CAUTION`, `WAITING`, `REPLANNING`, `BLOCKED`, and `GOAL_REACHED` rather than replanning on every detection.

Stub scenario example:

```json
{ "scenario": "missing-front-sensor" }
```

## WebSocket

Connect to `ws://localhost:4000/ws`.

Messages are JSON discriminated unions:

```json
{ "type": "state", "data": { "schemaVersion": 1 } }
```

```json
{ "type": "event", "data": { "level": "info", "message": "..." } }
```

## Stub Scenarios

- `normal`: deterministic 10 Hz telemetry, stable sensor progression, battery drains slowly.
- `missing-front-sensor`: front ultrasonic reading is `null`; other sensors remain valid.
- `missing-multiple-sensors`: left and front ultrasonic readings are `null`.
- `temporary-disconnect`: transport status becomes disconnected and motion output is zeroed.
- `reconnect`: reconnects to idle without replaying movement.
- `rejected-command`: next command is rejected without mutating successful-command metrics.
- `reset-baseline`: resets counters, telemetry sequence, command output, battery, and scenario.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

Run Selenium IDE and JMeter using the procedures in `docs/selenium` and `docs/jmeter`.
