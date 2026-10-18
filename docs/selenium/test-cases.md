# Selenium IDE Functional Test Cases

Base URL: `http://localhost:3000`

Before each scenario that mutates state, use Diagnostics & Testing -> `reset-stub`, or call `POST /api/diagnostics/stub/scenario` with `{ "scenario": "reset-baseline" }`.

| Test ID | Objective | Preconditions | Steps | Expected result | Actual result | Status | Evidence filename |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Application loads | Backend and frontend running | Open base URL; wait for `data-testid=app-root` | App shell appears without console-visible failure | Pending execution | Not run | F01-app-load.png |
| F02 | Backend health is displayed | F01 complete | Assert `data-testid=backend-status` contains `online` | Backend status is online | Pending execution | Not run | F02-health.png |
| F03 | Initial robot state is rendered | Reset baseline | Assert `robot-mode`, `telemetry-sequence`, `battery-voltage` are visible | Mode is idle, sequence is numeric, battery has V units | Pending execution | Not run | F03-initial-state.png |
| F04 | Stub telemetry sequence advances | Reset baseline | Store `telemetry-sequence`; wait until value changes | Sequence increases | Pending execution | Not run | F04-telemetry.png |
| F05 | Valid forward command succeeds | Reset baseline | Open Manual Control; click `drive-forward`; wait for `command-result` | Command accepted by stub transport | Pending execution | Not run | F05-forward.png |
| F06 | Invalid PWM is rejected | Backend running | Use API or form value outside range and submit command | API returns 422 or UI reports rejection | Pending execution | Not run | F06-invalid-pwm.png |
| F07 | Stop command succeeds | Movement command applied | Click `drive-stop`; wait for applied PWM to become 0 | Stop confirmed and motors are zero | Pending execution | Not run | F07-stop.png |
| F08 | Emergency stop locks out movement | Reset baseline | Click `emergency-stop`; click `drive-forward` | Movement rejected until latch cleared | Pending execution | Not run | F08-estop.png |
| F09 | Target coordinates are validated | Mapping tab visible | Enter valid `target-x` and `target-y`; click `set-target` | Target accepted | Pending execution | Not run | F09-target-valid.png |
| F10 | Invalid target is rejected | Mapping tab visible | Enter target beyond +/-1000 cm; click `set-target` | Rejection is shown | Pending execution | Not run | F10-target-invalid.png |
| F11 | Missing sensor data is displayed correctly | Diagnostics tab visible | Select `missing-front-sensor`; assert `front-distance` shows `null` or missing | Null is visible, not zero | Pending execution | Not run | F11-missing-sensor.png |
| F12 | Transport disconnection is displayed | Diagnostics tab visible | Select `temporary-disconnect`; assert `transport-status` and stale warning | Disconnected/stale state visible | Pending execution | Not run | F12-disconnect.png |
| F13 | Reconnection restores live updates without duplicate stub | F12 complete | Select `reconnect`; observe telemetry sequence increments once per cadence | Live updates resume without reset or burst duplication | Pending execution | Not run | F13-reconnect.png |
| F14 | Reset restores documented baseline | State mutated | Click `reset-stub`; assert sequence 0 and mode idle | Baseline restored | Pending execution | Not run | F14-reset.png |
| F15 | Empty map and absent path data are handled | Mapping tab visible | Inspect `map-canvas`; set target by clicking canvas | Grid renders and no fake path appears | Pending execution | Not run | F15-map.png |

## Selenium IDE Procedure

1. Start the backend and frontend.
2. Create a Selenium IDE project with base URL `http://localhost:3000`.
3. Use CSS selectors such as `[data-testid="drive-forward"]`; do not use layout selectors.
4. Prefer `wait for element visible`, `wait for text`, and `wait for element editable` over fixed sleeps.
5. Export screenshots or Selenium run logs using the evidence filenames listed above.
6. Fill the Actual result and Status columns only after running the cases.
