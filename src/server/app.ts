import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { ApiResponse, HealthResponse, RobotState } from "@/shared/protocol";
import type { Clock } from "./clock";
import { SystemClock } from "./clock";
import { MetricsCollector } from "./metrics";
import { RobotStateStore } from "./state";
import { TransportManager } from "./transportManager";
import { validateCommand, validateDynamicObject, validateDynamicObjectControl, validateLayout, validateNavigationConfig, validateScenario, validateTarget } from "./validation";

function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data } satisfies ApiResponse<T>);
}

function fail(res: Response, status: number, code: string, message: string, details?: Record<string, string>): void {
  res.status(status).json({ ok: false, error: { code, message, details } } satisfies ApiResponse<never>);
}

export interface CadeBackend {
  app: express.Express;
  manager: TransportManager;
  metrics: MetricsCollector;
  store: RobotStateStore;
  attachWebSocket(server: Server): WebSocketServer;
}

export function createBackend(clock: Clock = new SystemClock(), useTimer = true): CadeBackend {
  const app = express();
  const store = new RobotStateStore(clock, "stub");
  const metrics = new MetricsCollector(clock);
  const manager = new TransportManager(store, metrics, clock, useTimer);
  manager.start();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.CADE_ALLOWED_ORIGIN ?? "http://localhost:3000");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use((req, res, next) => {
    const start = performance.now();
    res.on("finish", () => metrics.trackRequest(res.statusCode, performance.now() - start));
    next();
  });

  app.get("/api/health", (_req, res) => {
    const state = store.snapshot();
    ok<HealthResponse>(res, {
      service: "cade-rover-control-center",
      version: process.env.npm_package_version ?? "0.1.0",
      uptimeMs: metrics.snapshot(state).uptimeMs,
      transport: state.transport
    });
  });

  app.get("/api/robot/state", (_req, res) => ok<RobotState>(res, store.snapshot()));

  app.post("/api/robot/commands", async (req, res) => {
    const validated = validateCommand(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_COMMAND", "Command validation failed.", validated.errors);
      return;
    }
    try {
      const state = await manager.submit(validated.value);
      const latest = state.diagnostics.latestCommand;
      if (latest?.accepted) ok(res, latest, 202);
      else fail(res, 409, "COMMAND_REJECTED", latest?.message ?? "Command was rejected.");
    } catch {
      fail(res, 500, "COMMAND_ERROR", "Command processing failed.");
    }
  });

  app.get("/api/navigation/status", (_req, res) => ok(res, store.snapshot().navigation));

  app.post("/api/navigation/target", (req, res) => {
    const validated = validateTarget(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_TARGET", "Navigation target validation failed.", validated.errors);
      return;
    }
    const state = manager.snapshot().navigation.status === "unavailable" ? store.snapshot() : manager.setNavigationTarget(validated.value);
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/navigation/start", (_req, res) => {
    const state = manager.startNavigation();
    if (state.navigation.status === "moving") {
      ok(res, { navigation: state.navigation, robot: state.robot }, 202);
      return;
    }
    fail(res, 409, "NAVIGATION_NOT_STARTED", "Navigation could not start. Check target, obstacle map, or emergency stop state.");
  });

  app.post("/api/navigation/stop", (_req, res) => {
    const state = manager.stopNavigation();
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/battery/refresh", (_req, res) => {
    ok(res, manager.refreshTestBattery(), 202);
  });

  app.post("/api/recording/start", (_req, res) => {
    ok(res, manager.startSceneRecording(), 202);
  });

  app.post("/api/recording/stop", (_req, res) => {
    ok(res, manager.stopSceneRecording(), 202);
  });

  app.post("/api/recording/replay", (_req, res) => {
    ok(res, manager.replayRecordedScene(), 202);
  });

  app.post("/api/navigation/dynamic-object", (req, res) => {
    const validated = Object.keys(req.body ?? {}).length > 0 ? validateDynamicObject(req.body) : { ok: true as const, value: undefined };
    if (!validated.ok) {
      fail(res, 422, "INVALID_DYNAMIC_OBJECT", "Dynamic object validation failed.", validated.errors);
      return;
    }
    const state = manager.addDynamicObject(validated.value?.object);
    if (validated.value?.object && !manager.hasDynamicObject(validated.value.object.id)) {
      fail(res, 422, "DYNAMIC_ROUTE_REJECTED", "No safe cardinal route could be created through the drawn points. Move the affected point away from static obstacles or world edges.");
      return;
    }
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/navigation/dynamic-object/control", (req, res) => {
    const validated = validateDynamicObjectControl(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_DYNAMIC_OBJECT_CONTROL", "Dynamic object control validation failed.", validated.errors);
      return;
    }
    const state = manager.controlDynamicObject(validated.value.id, validated.value.action, validated.value.speedCmPerSec);
    const exists = state.navigation.obstacles.some((object) => object.id === validated.value!.id);
    if (!exists) {
      fail(res, 404, "DYNAMIC_OBJECT_NOT_FOUND", "Dynamic object was not found.");
      return;
    }
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/navigation/dynamic-objects/stop", (_req, res) => {
    const state = manager.stopAllDynamicObjects();
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/navigation/config", (req, res) => {
    const validated = validateNavigationConfig(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_NAV_CONFIG", "Navigation configuration validation failed.", validated.errors);
      return;
    }
    const state = manager.updateNavigationConfig(validated.value);
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.post("/api/layout/apply", (req, res) => {
    const validated = validateLayout(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_LAYOUT", "Layout validation failed.", validated.errors);
      return;
    }
    const state = manager.applyLayout(validated.value);
    if (state.navigation.world.validationErrors.length > 0) {
      fail(res, 422, "LAYOUT_REJECTED", "Static layout is not valid.", { layout: state.navigation.world.validationErrors.join(" ") });
      return;
    }
    ok(res, { navigation: state.navigation, robot: state.robot }, 202);
  });

  app.get("/api/metrics", (_req, res) => ok(res, metrics.snapshot(store.snapshot())));

  app.post("/api/diagnostics/stub/scenario", (req, res) => {
    const validated = validateScenario(req.body);
    if (!validated.ok || !validated.value) {
      fail(res, 422, "INVALID_SCENARIO", "Stub scenario validation failed.", validated.errors);
      return;
    }
    ok(res, manager.setScenario(validated.value.scenario), 202);
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof SyntaxError) {
      fail(res, 400, "INVALID_JSON", "Request body is not valid JSON.");
      return;
    }
    fail(res, 500, "INTERNAL_ERROR", "Unexpected backend error.");
  };
  app.use(errorHandler);

  return {
    app,
    manager,
    metrics,
    store,
    attachWebSocket(server: Server): WebSocketServer {
      const wss = new WebSocketServer({ server, path: "/ws" });
      wss.on("connection", (socket) => {
        const unsubscribe = manager.onMessage((message) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        });
        socket.on("close", unsubscribe);
        socket.on("error", unsubscribe);
      });
      return wss;
    }
  };
}
