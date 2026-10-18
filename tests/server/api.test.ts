import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { createBackend } from "@/server/app";
import { ManualClock } from "@/server/clock";

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const backend = createBackend(new ManualClock(), false);
  const server = createServer(backend.app);
  backend.attachWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("REST API", () => {
  it("returns health and state without mutation", async () => {
    await withServer(async (baseUrl) => {
      const before = await fetch(`${baseUrl}/api/robot/state`).then((res) => res.json());
      const health = await fetch(`${baseUrl}/api/health`).then((res) => res.json());
      const after = await fetch(`${baseUrl}/api/robot/state`).then((res) => res.json());
      expect(health.ok).toBe(true);
      expect(after.data.telemetry.sequence).toBe(before.data.telemetry.sequence);
    });
  });

  it("rejects invalid commands with consistent errors", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/robot/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "drive", leftPwm: 999, rightPwm: 0 })
      });
      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("INVALID_COMMAND");
    });
  });

  it("handles reset and missing sensor scenario", async () => {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/diagnostics/stub/scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "missing-front-sensor" })
      });
      const reset = await fetch(`${baseUrl}/api/diagnostics/stub/scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: "reset-baseline" })
      }).then((res) => res.json());
      expect(reset.data.telemetry.sequence).toBe(0);
    });
  });

  it("reports a rejected dynamic route instead of returning a false success", async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/navigation/dynamic-object`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          object: {
            id: "impossible-route",
            name: "Impossible route",
            widthCm: 20,
            heightCm: 20,
            start: { xCm: 9999, yCm: 9999 },
            goal: { xCm: 9999, yCm: 9999 },
            waypoints: [{ xCm: 9999, yCm: 9999 }, { xCm: 9999, yCm: 9999 }],
            speedCmPerSec: 20
          }
        })
      });
      const body = await response.json();
      expect(response.status).toBe(422);
      expect(body.error.code).toBe("DYNAMIC_ROUTE_REJECTED");
    });
  });

  it("switches navigation policy and refreshes the test battery", async () => {
    await withServer(async (baseUrl) => {
      const config = await fetch(`${baseUrl}/api/navigation/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { strategy: "rule-based" } })
      }).then((res) => res.json());
      expect(config.ok).toBe(true);
      expect(config.data.navigation.config.strategy).toBe("rule-based");
      const battery = await fetch(`${baseUrl}/api/battery/refresh`, { method: "POST" }).then((res) => res.json());
      expect(battery.ok).toBe(true);
      expect(battery.data.battery).toMatchObject({ percent: 100, remainingJoules: 36_000 });
    });
  });
});
