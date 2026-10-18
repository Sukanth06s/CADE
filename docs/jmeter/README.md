# JMeter Performance Test Procedure

Backend base URL: `http://localhost:4000`

JMeter should test the backend REST API only. Do not use JMeter to benchmark browser rendering or Canvas drawing.

## Suggested Variables

- `BASE_URL`: `http://localhost:4000`
- `THREADS`: start with `5`
- `RAMP_UP`: start with `10`
- `DURATION`: start with `60`

## Scenarios

P01 Baseline health endpoint:

- Thread Group: `${THREADS}`, ramp-up `${RAMP_UP}`, duration `${DURATION}`
- HTTP GET `${BASE_URL}/api/health`
- Assertion: response code `200`, JSON `ok=true`

P02 Repeated robot-state reads:

- HTTP GET `${BASE_URL}/api/robot/state`
- Assertion: response code `200`, JSON `ok=true`

P03 Valid command requests:

- HTTP POST `${BASE_URL}/api/robot/commands`
- Body: `{ "type": "drive", "leftPwm": 80, "rightPwm": 80 }`
- Cleanup sampler: POST stop command `{ "type": "stop" }`
- Assertion: response code `202`

P04 Invalid command requests:

- HTTP POST `${BASE_URL}/api/robot/commands`
- Body: `{ "type": "drive", "leftPwm": 999, "rightPwm": 0 }`
- Assertion: response code `422`
- Treat expected 422 responses as correct handling, not unexpected failures.

P05 Mixed health/state traffic:

- Use a Throughput Controller or Interleave Controller with GET `/api/health` and GET `/api/robot/state`.

P06 Increasing load:

- Repeat P01/P02/P03 with `THREADS` increased gradually, for example 5, 10, 20.
- Stop if local CPU saturation or unexpected backend failures occur.

## Report Fields

Use actual JMeter output only:

- Number of requests.
- Successful requests.
- Unexpected failures.
- Average response time.
- Median response time.
- 90th and 95th percentile response time.
- Throughput.
- Error percentage.
- Test duration.
- Thread count and ramp-up.
- Machine and environment details.

Clearly separate HTTP request throughput from backend handler duration, browser rendering rate, and telemetry update rate.
