"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROVER_CONFIG, STUB_NOTICE } from "@/shared/roverConfig";
import type { ApiResponse, CommandResult, DynamicObjectConfig, HealthResponse, RobotState, RuntimeMetrics, StaticObject, StubScenario, WsMessage } from "@/shared/protocol";
import { api, WS_URL } from "@/frontend/api";

const tabs = ["Overview", "Mapping & Navigation", "Manual Control", "Diagnostics & Testing"] as const;
type Tab = (typeof tabs)[number];

function fmt(value: number | null | undefined, suffix = "", digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "null";
  return `${value.toFixed(digits)}${suffix}`;
}

function useRoverState() {
  const [state, setState] = useState<RobotState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "live" | "stale">("connecting");
  const [apiError, setApiError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [healthResult, stateResult, metricsResult] = await Promise.all([api.health(), api.state(), api.metrics()]);
    if (healthResult.ok) setHealth(healthResult.data);
    if (stateResult.ok) setState(stateResult.data);
    if (metricsResult.ok) setMetrics(metricsResult.data);
    const firstError = [healthResult, stateResult, metricsResult].find((result) => !result.ok) as ApiResponse<unknown> | undefined;
    setApiError(firstError && !firstError.ok ? firstError.error.message : null);
  }, []);

  useEffect(() => {
    void refresh();
    const socket = new WebSocket(WS_URL);
    socket.onopen = () => setWsStatus("live");
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as WsMessage;
      if (message.type === "state") setState(message.data);
      if (message.type === "metrics") setMetrics(message.data);
    };
    socket.onclose = () => setWsStatus("stale");
    socket.onerror = () => setWsStatus("stale");
    return () => socket.close();
  }, [refresh]);

  return { state, health, metrics, wsStatus, apiError, refresh, setState };
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="panel p-3">
      <div className="metric-label">{label}</div>
      <div className="metric-value mt-1" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

const dynamicColors = ["#f85149", "#f0883e", "#bc8cff", "#39c5cf", "#e3b341", "#ff7b72"];

function dynamicColor(id: string): string {
  return dynamicColors[[...id].reduce((total, char) => total + char.charCodeAt(0), 0) % dynamicColors.length];
}

function MapCanvas({ state, mode, dynamicRoute, expanded, zoomCommand, onTarget, onObstacle, onDynamicWaypoint, onOutOfBounds }: { state: RobotState; mode: "target" | "obstacle" | "dynamic-route"; dynamicRoute: Array<{ xCm: number; yCm: number }>; expanded: boolean; zoomCommand: number; onTarget: (x: number, y: number) => void; onObstacle: (x: number, y: number) => void; onDynamicWaypoint: (x: number, y: number) => void; onOutOfBounds: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const camera = useRef({ zoom: 0, panX: 0, panY: 0, worldKey: "", lastZoomCommand: 0, dragging: false, moved: false, pointerX: 0, pointerY: 0 });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    ctx.scale(scale, scale);
    const width = rect.width;
    const height = rect.height;
    const { widthCm, heightCm } = state.navigation.world;
    const worldKey = `${widthCm}:${heightCm}`;
    const fitZoom = Math.min((width - 48) / widthCm, (height - 48) / heightCm);
    if (camera.current.worldKey !== worldKey || camera.current.zoom === 0) {
      camera.current.zoom = fitZoom;
      camera.current.panX = 0;
      camera.current.panY = 0;
      camera.current.worldKey = worldKey;
    }
    if (camera.current.lastZoomCommand !== zoomCommand) {
      camera.current.zoom = Math.max(fitZoom * 0.5, Math.min(fitZoom * 20, camera.current.zoom * (zoomCommand > camera.current.lastZoomCommand ? 1.25 : 0.8)));
      camera.current.lastZoomCommand = zoomCommand;
    }
    const toScreen = (xCm: number, yCm: number) => ({
      x: width / 2 + camera.current.panX + xCm * camera.current.zoom,
      y: height / 2 + camera.current.panY - yCm * camera.current.zoom
    });
    ctx.fillStyle = "#0f141b";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#2f3d4f";
    ctx.lineWidth = 1;
    const cellCm = state.navigation.world.gridCellCm;
    const minWorldX = Math.ceil(((-width / 2 - camera.current.panX) / camera.current.zoom) / cellCm) * cellCm;
    const maxWorldX = Math.floor(((width / 2 - camera.current.panX) / camera.current.zoom) / cellCm) * cellCm;
    const minWorldY = Math.ceil(((-height / 2 + camera.current.panY) / camera.current.zoom) / cellCm) * cellCm;
    const maxWorldY = Math.floor(((height / 2 + camera.current.panY) / camera.current.zoom) / cellCm) * cellCm;
    for (let x = minWorldX; x <= maxWorldX; x += cellCm) {
      const a = toScreen(x, minWorldY);
      const b = toScreen(x, maxWorldY);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let y = minWorldY; y <= maxWorldY; y += cellCm) {
      const a = toScreen(minWorldX, y);
      const b = toScreen(maxWorldX, y);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    const worldTopLeft = toScreen(-widthCm / 2, heightCm / 2);
    const worldBottomRight = toScreen(widthCm / 2, -heightCm / 2);
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2;
    ctx.strokeRect(worldTopLeft.x, worldTopLeft.y, worldBottomRight.x - worldTopLeft.x, worldBottomRight.y - worldTopLeft.y);
    for (const cell of state.navigation.map.cells) {
      const screen = toScreen(cell.xCm, cell.yCm);
      ctx.fillStyle = cell.state === "free" ? "rgba(63, 185, 80, 0.14)" : cell.state === "dynamic" ? "rgba(248, 81, 73, 0.68)" : "rgba(242, 204, 96, 0.55)";
      ctx.fillRect(screen.x - 4, screen.y - 4, 8, 8);
    }

    if (state.navigation.trajectory.length > 1) {
      ctx.strokeStyle = "#bc8cff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      state.navigation.trajectory.forEach((point, index) => {
        const screen = toScreen(point.xCm, point.yCm);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }

    for (const obstacle of state.navigation.obstacles) {
      if (obstacle.route.length > 1) {
        ctx.strokeStyle = dynamicColor(obstacle.id);
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        obstacle.route.forEach((point, index) => {
          const routeScreen = toScreen(point.xCm, point.yCm);
          if (index === 0) ctx.moveTo(routeScreen.x, routeScreen.y);
          else ctx.lineTo(routeScreen.x, routeScreen.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const screen = toScreen(obstacle.xCm, obstacle.yCm);
      ctx.beginPath();
      ctx.fillStyle = obstacle.color ?? dynamicColor(obstacle.id);
      ctx.arc(screen.x, screen.y, Math.max(5, obstacle.radiusCm * camera.current.zoom), 0, Math.PI * 2);
      ctx.fill();
    }

    for (const track of state.navigation.tracks) {
      const interaction = state.navigation.dynamicInteractions.find((entry) => entry.trackId === track.id);
      if (!track.rawVelocity || track.velocityStatus !== "valid") continue;
      const start = toScreen(track.lastPosition.xCm, track.lastPosition.yCm);
      const end = toScreen(track.lastPosition.xCm + track.rawVelocity.vxCmPerSec * 0.5, track.lastPosition.yCm + track.rawVelocity.vyCmPerSec * 0.5);
      ctx.strokeStyle = interaction?.routeConflict ? "#f2cc60" : "#58a6ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state.navigation.path && state.navigation.path.length > 1) {
      ctx.strokeStyle = "#3fb950";
      ctx.lineWidth = 3;
      ctx.beginPath();
      state.navigation.path.forEach((point, index) => {
        const screen = toScreen(point.xCm, point.yCm);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
    }

    if (dynamicRoute.length > 0) {
      ctx.strokeStyle = "#f0883e";
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      dynamicRoute.forEach((point, index) => {
        const screen = toScreen(point.xCm, point.yCm);
        if (index === 0) ctx.moveTo(screen.x, screen.y);
        else ctx.lineTo(screen.x, screen.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      dynamicRoute.forEach((point, index) => {
        const screen = toScreen(point.xCm, point.yCm);
        ctx.fillStyle = index === 0 ? "#3fb950" : index === dynamicRoute.length - 1 ? "#f85149" : "#f0883e";
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
        ctx.fill();
      });
    }


    const origin = toScreen(state.robot.pose.xCm, state.robot.pose.yCm);
    ctx.fillStyle = "#8b949e";
    const mapInstruction = mode === "obstacle"
      ? "Obstacle mode: click grid to add a static blocked cell"
      : mode === "dynamic-route"
        ? "Dynamic route mode: click start, turning points, then end"
        : "Target mode: click a target, then press Set Target";
    ctx.fillText(`${mapInstruction}  World: ${widthCm} x ${heightCm} cm. Drag to pan; use map buttons to zoom. Grid: ${cellCm} x ${cellCm} cm.`, 12, 20);
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    const headingRad = (state.robot.pose.thetaDeg * Math.PI) / 180;
    const heading = toScreen(state.robot.pose.xCm - Math.sin(headingRad) * 18, state.robot.pose.yCm + Math.cos(headingRad) * 18);
    ctx.beginPath();
    ctx.moveTo(origin.x, origin.y);
    ctx.lineTo(heading.x, heading.y);
    ctx.stroke();
    if (state.navigation.target) {
      const target = toScreen(state.navigation.target.xCm, state.navigation.target.yCm);
      ctx.strokeStyle = "#f2cc60";
      ctx.beginPath();
      ctx.moveTo(target.x - 8, target.y);
      ctx.lineTo(target.x + 8, target.y);
      ctx.moveTo(target.x, target.y - 8);
      ctx.lineTo(target.x, target.y + 8);
      ctx.stroke();
    }
  }, [dynamicRoute, mode, state.navigation.dynamicInteractions, state.navigation.map.cells, state.navigation.obstacles, state.navigation.path, state.navigation.target, state.navigation.tracks, state.navigation.trajectory, state.navigation.world, state.robot.pose, zoomCommand]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  return (
    <div className="panel overflow-hidden">
      <canvas
        ref={canvasRef}
        data-testid="map-canvas"
        className={expanded ? "block h-[calc(100vh-8rem)] w-full cursor-crosshair" : "block h-[520px] w-full cursor-crosshair"}
        onPointerDown={(event) => {
          camera.current.dragging = true;
          camera.current.moved = false;
          camera.current.pointerX = event.clientX;
          camera.current.pointerY = event.clientY;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!camera.current.dragging) return;
          const dx = event.clientX - camera.current.pointerX;
          const dy = event.clientY - camera.current.pointerY;
          if (Math.abs(dx) + Math.abs(dy) > 2) camera.current.moved = true;
          camera.current.panX += dx;
          camera.current.panY += dy;
          camera.current.pointerX = event.clientX;
          camera.current.pointerY = event.clientY;
          draw();
        }}
        onPointerUp={(event) => {
          camera.current.dragging = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onClick={(event) => {
          if (camera.current.moved) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left - rect.width / 2 - camera.current.panX) / camera.current.zoom;
          const y = -(event.clientY - rect.top - rect.height / 2 - camera.current.panY) / camera.current.zoom;
          if (Math.abs(x) > state.navigation.world.widthCm / 2 || Math.abs(y) > state.navigation.world.heightCm / 2) {
            onOutOfBounds();
            return;
          }
          if (mode === "obstacle") onObstacle(Number(x.toFixed(1)), Number(y.toFixed(1)));
          else if (mode === "dynamic-route") onDynamicWaypoint(Number(x.toFixed(1)), Number(y.toFixed(1)));
          else onTarget(Number(x.toFixed(1)), Number(y.toFixed(1)));
        }}
      />
    </div>
  );
}

function LayerMap({ title, cells, state }: { title: string; cells: Array<{ xCm: number; yCm: number; state: string }>; state: RobotState }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    ctx.scale(scale, scale);
    ctx.fillStyle = "#0f141b";
    ctx.fillRect(0, 0, rect.width, rect.height);
    const zoom = Math.min(rect.width / state.navigation.world.widthCm, rect.height / state.navigation.world.heightCm) * 0.9;
    const toScreen = (xCm: number, yCm: number) => ({ x: rect.width / 2 + xCm * zoom, y: rect.height / 2 - yCm * zoom });
    ctx.strokeStyle = "#263241";
    ctx.strokeRect(8, 8, rect.width - 16, rect.height - 16);
    for (const cell of cells) {
      const screen = toScreen(cell.xCm, cell.yCm);
      ctx.fillStyle = cell.state === "dynamic" ? "rgba(248,81,73,0.75)" : cell.state === "observed" ? "rgba(88,166,255,0.65)" : "rgba(242,204,96,0.65)";
      ctx.fillRect(screen.x - 3, screen.y - 3, 6, 6);
    }
    const rover = toScreen(state.robot.pose.xCm, state.robot.pose.yCm);
    ctx.strokeStyle = "#58a6ff";
    ctx.beginPath();
    ctx.arc(rover.x, rover.y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#8b949e";
    ctx.fillText(title, 12, 18);
  }, [cells, state.navigation.world.heightCm, state.navigation.world.widthCm, state.robot.pose.xCm, state.robot.pose.yCm, title]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  return <canvas ref={canvasRef} className="block h-44 w-full rounded border border-[#263241]" />;
}

export default function Home() {
  const { state, health, metrics, wsStatus, apiError, refresh, setState } = useRoverState();
  const [tab, setTab] = useState<Tab>("Overview");
  const [leftPwm, setLeftPwm] = useState(120);
  const [rightPwm, setRightPwm] = useState(120);
  const [targetX, setTargetX] = useState(0);
  const [targetY, setTargetY] = useState(100);
  const [worldWidth, setWorldWidth] = useState(1000);
  const [worldHeight, setWorldHeight] = useState(500);
  const [gridCell, setGridCell] = useState(5);
  const [rectName, setRectName] = useState("Machine");
  const [rectX, setRectX] = useState(90);
  const [rectY, setRectY] = useState(20);
  const [rectW, setRectW] = useState(30);
  const [rectH, setRectH] = useState(40);
  const [nominalSpeed, setNominalSpeed] = useState(50);
  const [cautionSpeed, setCautionSpeed] = useState(20);
  const [hardClearance, setHardClearance] = useState(5);
  const [softClearance, setSoftClearance] = useState(10);
  const [stuckMs, setStuckMs] = useState(5000);
  const [dynSpeed, setDynSpeed] = useState(22);
  const [dynamicRoute, setDynamicRoute] = useState<Array<{ xCm: number; yCm: number }>>([]);
  const [selectedDynamicId, setSelectedDynamicId] = useState<string | null>(null);
  const [dynamicRouteError, setDynamicRouteError] = useState<string | null>(null);
  const [commandResult, setCommandResult] = useState<string>("No command submitted.");
  const [mapMode, setMapMode] = useState<"target" | "obstacle" | "dynamic-route">("target");
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mapZoomCommand, setMapZoomCommand] = useState(0);

  const disabled = !state || !state.transport.connected;
  const stateAge = state ? Date.now() - state.telemetry.lastUpdateMs : 0;
  const stale = wsStatus !== "live" || Boolean(state?.telemetry.stale) || stateAge > 3000;
  const selectedDynamicObject = state?.navigation.obstacles.find((object) => object.id === selectedDynamicId) ?? null;

  const navConfig = state?.navigation.config;
  const applyNavigationResponse = (response: { navigation: RobotState["navigation"]; robot: RobotState["robot"] }) => {
    setState((current) => current ? { ...current, navigation: response.navigation, robot: response.robot } : current);
  };
  useEffect(() => {
    if (!navConfig) return;
    setNominalSpeed(navConfig.nominalSpeedCmPerSec);
    setCautionSpeed(navConfig.cautionSpeedCmPerSec);
    setHardClearance(navConfig.hardClearanceCm);
    setSoftClearance(navConfig.softClearanceCm);
    setStuckMs(navConfig.stuckBeforeReplanMs);
  }, [navConfig]);

  const submitCommand = async (left: number, right: number) => {
    const result = await api.command({ type: "drive", leftPwm: left, rightPwm: right });
    handleCommandResult(result);
  };

  const handleCommandResult = (result: ApiResponse<CommandResult>) => {
    if (result.ok) setCommandResult(result.data.message);
    else setCommandResult(`${result.error.code}: ${result.error.message}`);
    void refresh();
  };

  const sensorCards = useMemo(() => {
    if (!state) return null;
    return (["left", "front", "right"] as const).map((key) => (
      <Stat
        key={key}
        label={`${key} ultrasonic`}
        value={`${state.ultrasonic[key].cm === null ? "null" : fmt(state.ultrasonic[key].cm, " cm")} ${state.ultrasonic[key].valid ? "" : "(missing)"}`}
        testId={key === "front" ? "front-distance" : undefined}
      />
    ));
  }, [state]);

  if (!state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0d1117] text-[#e6edf3]" data-testid="app-root">
        <div className="panel p-6">Loading CADE Rover Control Center...</div>
      </main>
    );
  }

  // Older backend processes can briefly serve snapshots from before RMAAP fields existed.
  // Keep the control screen usable while the fresh telemetry state arrives.
  const adaptiveDecision = state.navigation.adaptiveDecision ?? {
    action: "NO_CHANGE",
    severity: "none",
    reason: "RMAAP assessment is not available from this telemetry snapshot.",
    costEstimates: []
  };
  const dynamicInteractions = state.navigation.dynamicInteractions ?? [];

  return (
    <main className="min-h-screen bg-[#0d1117] text-[#e6edf3]" data-testid="app-root">
      <header className="border-b border-[#263241] bg-[#111820] px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">CADE Rover Control Center</h1>
            <p className="mt-1 text-sm text-[#8b949e]">{ROVER_CONFIG.coordinateConvention}</p>
          </div>
          <div className="rounded border border-[#f2cc60] px-3 py-2 text-sm font-semibold text-[#f2cc60]" data-testid="transport-status">
            {state.transport.notice || STUB_NOTICE}
          </div>
        </div>
      </header>

      <section className="px-6 py-4">
        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="Backend" value={health ? "online" : apiError ?? "unreachable"} testId="backend-status" />
          <Stat label="WebSocket" value={wsStatus} />
          <Stat label="Robot mode" value={state.robot.mode} testId="robot-mode" />
          <Stat label="Telemetry sequence" value={String(state.telemetry.sequence)} testId="telemetry-sequence" />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-[#263241] bg-[#111820] px-3 py-3">
          <div>
            <div className="metric-label">Navigation system</div>
            <div className="mt-1 text-sm text-[#8b949e]">CADE uses relative-motion-aware choices. Fixed rule waits on an obstacle, then reroutes after 3 seconds.</div>
          </div>
          <select aria-label="Navigation system" className="rounded border border-[#263241] bg-[#0d1117] px-3 py-2 text-sm font-semibold" value={state.navigation.config.strategy} onChange={async (event) => { const strategy = event.target.value as "cade" | "rule-based"; const result = await api.navigationConfig({ strategy }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult(strategy === "cade" ? "CADE motion-aware navigation selected." : "Fixed rule-based navigation selected: wait, then reroute after 3 seconds."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>
            <option value="cade">CADE adaptive navigation</option>
            <option value="rule-based">Industry fixed-rule baseline</option>
          </select>
          <div className="border-l border-[#263241] pl-3">
            <div className="metric-label">Test battery</div>
            <div className="mt-1 font-semibold">{fmt(state.battery.percent, "%", 1)} · {fmt(state.battery.remainingJoules / 1000, " kJ", 2)} remaining</div>
            <div className="text-xs text-[#8b949e]">{fmt(state.battery.usedJoules, " J", 1)} consumed of {fmt(state.battery.capacityJoules, " J", 0)}</div>
          </div>
          <button className="rounded border border-[#58a6ff] px-3 py-2 text-sm font-semibold text-[#58a6ff]" onClick={async () => { const result = await api.refreshBattery(); if (result.ok) { setState(result.data); setCommandResult("Test battery restored to 100%."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Recharge Battery</button>
        </div>
        {stale && <div className="mt-3 rounded border border-[#f85149] bg-[#2b1719] px-3 py-2 text-sm text-[#ffa198]">Telemetry is stale or disconnected. Last known values remain visible.</div>}
      </section>

      <nav className="flex flex-wrap gap-2 px-6">
        {tabs.map((item) => (
          <button
            key={item}
            className={`rounded border px-3 py-2 text-sm ${tab === item ? "border-[#58a6ff] bg-[#19324d] text-white" : "border-[#263241] bg-[#151b23] text-[#8b949e]"}`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>

      <section className="p-6">
        {tab === "Overview" && (
          <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
            <div className="grid gap-3 md:grid-cols-3">
              <Stat label="Battery" value={`${fmt(state.battery.percent, "%", 1)} (${fmt(state.battery.voltage, " V", 2)})`} testId="battery-voltage" />
              <Stat label="Left PWM" value={String(state.motors.leftAppliedPwm)} />
              <Stat label="Right PWM" value={String(state.motors.rightAppliedPwm)} />
              <Stat label="Left encoder" value={`${state.encoders.leftPulses} pulses`} />
              <Stat label="Right encoder" value={`${state.encoders.rightPulses} pulses`} />
              <Stat label="Pose" value={state.robot.pose.valid ? `${fmt(state.robot.pose.xCm)}, ${fmt(state.robot.pose.yCm)}` : "unavailable"} />
              {sensorCards}
            </div>
            <LogPanel state={state} commandResult={commandResult} />
          </div>
        )}

        {tab === "Mapping & Navigation" && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Navigation" value={state.navigation.status} />
              <Stat label="CADE" value={state.navigation.cadeState} />
              <Stat label="Rover pose" value={`${fmt(state.robot.pose.xCm)}, ${fmt(state.robot.pose.yCm)} cm`} />
              <Stat label="Tracked objects" value={String(state.navigation.tracks.length)} />
            </div>
            <div className="panel p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Live Navigation Map</h2>
                  <p className="mt-1 text-sm text-[#8b949e]">Blue: rover. Green: planned route. Purple: rover trail. Red: dynamic object. Orange dashed: draft dynamic route.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
                  <button className={`rounded border px-3 py-2 text-sm font-semibold ${mapMode === "target" ? "border-[#58a6ff] bg-[#19324d]" : "border-[#263241]"}`} onClick={() => setMapMode("target")}>Set Target</button>
                  <button data-testid="draw-obstacle-mode" className={`rounded border px-3 py-2 text-sm font-semibold ${mapMode === "obstacle" ? "border-[#f2cc60] bg-[#3d2d0a]" : "border-[#263241]"}`} onClick={() => setMapMode("obstacle")}>Draw Obstacle</button>
                  <button className={`rounded border px-3 py-2 text-sm font-semibold ${mapMode === "dynamic-route" ? "border-[#f0883e] bg-[#3d220f]" : "border-[#263241]"}`} onClick={() => setMapMode("dynamic-route")}>Draw Dynamic Route</button>
                  <button className="rounded border border-[#263241] px-3 py-2 text-sm font-semibold" onClick={() => setMapZoomCommand((command) => command + 1)}>Zoom In</button>
                  <button className="rounded border border-[#263241] px-3 py-2 text-sm font-semibold" onClick={() => setMapZoomCommand((command) => command - 1)}>Zoom Out</button>
                  <button className="rounded border border-[#263241] px-3 py-2 text-sm font-semibold" onClick={() => setMapExpanded((expanded) => !expanded)}>{mapExpanded ? "Compact Map" : "Expand Map"}</button>
                </div>
              </div>
              <div className="mt-3"><MapCanvas state={state} mode={mapMode} dynamicRoute={dynamicRoute} expanded={mapExpanded} zoomCommand={mapZoomCommand} onOutOfBounds={() => setCommandResult(`Map selection is outside the ${state.navigation.world.widthCm} x ${state.navigation.world.heightCm} cm navigation boundary.`)} onTarget={(x, y) => { setTargetX(Math.round(x / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm); setTargetY(Math.round(y / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm); }} onDynamicWaypoint={(x, y) => { setDynamicRouteError(null); setDynamicRoute((route) => [...route, { xCm: Math.round(x / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm, yCm: Math.round(y / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm }]); }} onObstacle={async (x, y) => {
                const snappedX = Math.round(x / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm;
                const snappedY = Math.round(y / state.navigation.world.gridCellCm) * state.navigation.world.gridCellCm;
                const object: StaticObject = { kind: "cells", id: `drawn-${Date.now()}`, name: "Drawn obstacle", cells: [{ xCm: snappedX, yCm: snappedY }] };
                const result = await api.layout({ widthCm: state.navigation.world.widthCm, heightCm: state.navigation.world.heightCm, gridCellCm: state.navigation.world.gridCellCm, roverStart: state.navigation.world.roverStart, target: state.navigation.target, staticObjects: [...state.navigation.world.staticObjects, object] });
                if (result.ok) { applyNavigationResponse(result.data); setCommandResult(`Obstacle drawn at ${snappedX}, ${snappedY} cm.`); } else setCommandResult(`${result.error.code}: ${result.error.message}`);
              }} /></div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-[#263241] bg-[#0d1117] px-3 py-2 text-sm"><span>Navigation world: <strong>{state.navigation.world.widthCm} x {state.navigation.world.heightCm} cm</strong> · Grid: <strong>{state.navigation.world.gridCellCm} x {state.navigation.world.gridCellCm} cm ({state.navigation.world.gridCellCm ** 2} cm²)</strong></span><button className="rounded bg-[#1f6feb] px-3 py-1.5 font-semibold text-white" onClick={async () => { const result = await api.layout({ widthCm: 1000, heightCm: 500, gridCellCm: 5, roverStart: state.navigation.world.roverStart, target: state.navigation.target, staticObjects: state.navigation.world.staticObjects }); if (result.ok) { applyNavigationResponse(result.data); setWorldWidth(1000); setWorldHeight(500); setGridCell(5); setCommandResult("Standard world applied: 1000 x 500 cm with 5 x 5 cm cells."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Use Standard World</button></div>
            </div>
            <SceneRecordingPanel state={state} setState={setState} setCommandResult={setCommandResult} />
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="panel p-4">
                <h3 className="font-semibold">Rover Navigation</h3>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <label className="text-sm">Target X<input data-testid="target-x" className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={targetX} onChange={(e) => setTargetX(Number(e.target.value))} /></label>
                  <label className="text-sm">Target Y<input data-testid="target-y" className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={targetY} onChange={(e) => setTargetY(Number(e.target.value))} /></label>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button data-testid="set-target" className="rounded bg-[#238636] px-3 py-2 font-semibold text-white" onClick={async () => { const result = await api.target(targetX, targetY); if (result.ok) { applyNavigationResponse(result.data); setCommandResult(result.data.navigation.status === "planned" ? "Target planned." : `Target unavailable: ${result.data.navigation.lastTransitionReason}`); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Set Target</button>
                  <button data-testid="start-navigation" className="rounded bg-[#1f6feb] px-3 py-2 font-semibold text-white disabled:opacity-50" disabled={!state.navigation.target || state.robot.emergencyStopLatched || state.navigation.status === "moving"} onClick={async () => { const result = await api.startNavigation(); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Navigation started."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Start</button>
                  <button data-testid="stop-navigation" className="rounded bg-[#8b949e] px-3 py-2 font-semibold text-black" onClick={async () => { const result = await api.stopNavigation(); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Navigation stopped."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Stop</button>
                </div>
                <div className="mt-4 rounded border border-[#263241] bg-[#0d1117] p-3" data-testid="cade-decision">
                  <div className="metric-label">CADE decision</div><div className="mt-1 text-lg font-semibold text-[#f2cc60]">{state.navigation.decision.action}</div>
                  <div className="mt-1 text-sm text-[#8b949e]">{state.navigation.decision.reason}</div>
                  <div className="mt-2 text-sm">PWM {state.navigation.decision.leftPwm}/{state.navigation.decision.rightPwm} · Clear {state.navigation.decision.clearForMs} ms</div>
                  <div className="mt-3 border-t border-[#263241] pt-3">
                    <div className="metric-label">RMAAP assessment</div>
                    <div className="mt-1 font-semibold">{adaptiveDecision.action} · {adaptiveDecision.severity}</div>
                    <div className="mt-1 text-sm text-[#8b949e]">{adaptiveDecision.reason}</div>
                    <div className="mt-2 text-xs text-[#8b949e]">Blockage {state.navigation.waitStartedMs === null ? "not active" : `${Math.max(0, state.timestampMs - state.navigation.waitStartedMs)} ms`} · {state.navigation.cadeState} · route {state.navigation.lastReplanRouteFingerprint ? "recovery available" : "current"}</div>
                    <div className="mt-2 text-xs text-[#8b949e]">{adaptiveDecision.costEstimates.length === 0 ? "Energy estimate unavailable for this snapshot." : adaptiveDecision.costEstimates.map((cost) => cost.available ? `${cost.action}: ${fmt(cost.energyJoules, " J")} / ${fmt(cost.expectedTimeSec, " s")}` : `${cost.action}: unavailable`).join(" · ")}</div>
                    {dynamicInteractions.length > 0 && <div className="mt-2 space-y-1 text-xs text-[#8b949e]">{dynamicInteractions.slice(0, 3).map((interaction) => <div key={interaction.trackId}>{interaction.trackId}: {interaction.detectionStatus}, {interaction.velocityStatus}, {interaction.relativeMotionStatus}{interaction.relativeVelocity ? ` (${fmt(interaction.relativeVelocity.vxCmPerSec)}, ${fmt(interaction.relativeVelocity.vyCmPerSec)} cm/s)` : ""}{interaction.routeConflict ? ` · route conflict ${fmt(interaction.routeConflictTimeSec, " s")}` : ""}{interaction.collisionTimeSec !== null ? ` · TTC ${fmt(interaction.collisionTimeSec, " s")}` : ""}</div>)}</div>}
                  </div>
                </div>
              </div>
              <div className="panel p-4">
                <h3 className="font-semibold">Dynamic Object Route</h3>
                <p className="mt-1 text-sm text-[#8b949e]">Select Draw Dynamic Route, then click start, turning points, and end on the map.</p>
                <div className="mt-3 rounded border border-[#263241] bg-[#0d1117] p-3 text-sm">Draft points: <span className="font-semibold">{dynamicRoute.length}</span>{dynamicRoute.length > 0 && <span className="text-[#8b949e]"> · Start {fmt(dynamicRoute[0].xCm)}, {fmt(dynamicRoute[0].yCm)} · End {fmt(dynamicRoute[dynamicRoute.length - 1].xCm)}, {fmt(dynamicRoute[dynamicRoute.length - 1].yCm)}</span>}</div>
                <label className="mt-3 block text-sm">Speed: {dynSpeed} cm/s<input className="mt-2 w-full accent-[#58a6ff]" type="range" min={5} max={100} step={1} value={dynSpeed} onChange={(e) => setDynSpeed(Number(e.target.value))} /></label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button className="rounded border border-[#263241] px-3 py-2 font-semibold" onClick={() => { setDynamicRouteError(null); setDynamicRoute((route) => route.slice(0, -1)); }} disabled={dynamicRoute.length === 0}>Undo Point</button>
                  <button className="rounded border border-[#263241] px-3 py-2 font-semibold" onClick={() => { setDynamicRouteError(null); setDynamicRoute([]); }} disabled={dynamicRoute.length === 0}>Clear Route</button>
                </div>
                <button data-testid="add-dynamic-object" className="mt-3 w-full rounded bg-[#9e6a03] px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={dynamicRoute.length < 2} onClick={async () => {
                  if (dynamicRoute.length < 2) return;
                  const id = `dynamic-${Date.now()}`;
                  const object: DynamicObjectConfig = { id, name: "Drawn mover", widthCm: 22, heightCm: 22, start: dynamicRoute[0], goal: dynamicRoute[dynamicRoute.length - 1], waypoints: dynamicRoute, speedCmPerSec: dynSpeed };
                  const result = await api.dynamicObject(object);
                  if (result.ok) { applyNavigationResponse(result.data); setDynamicRoute([]); setDynamicRouteError(null); setSelectedDynamicId(id); setMapMode("dynamic-route"); setCommandResult("Dynamic object route created. Draft cleared: click a new start point to draw the next route."); } else { setDynamicRouteError(result.error.message); setCommandResult(`${result.error.code}: ${result.error.message}`); }
                }}>Create Dynamic Object</button>
                {dynamicRouteError && <div className="mt-2 rounded border border-[#f85149] bg-[#2b1719] px-3 py-2 text-sm text-[#ffa198]">{dynamicRouteError}</div>}
                <div className="mt-3 rounded border border-[#263241] bg-[#0d1117] p-3 text-sm"><div className="metric-label">Active object</div><div className="mt-1 font-semibold">{selectedDynamicObject ? `${selectedDynamicObject.id} · ${selectedDynamicObject.status}` : "None configured"}</div>{selectedDynamicObject && <div className="mt-1 text-[#8b949e]">{fmt(selectedDynamicObject.xCm)}, {fmt(selectedDynamicObject.yCm)} cm · {fmt(selectedDynamicObject.speedCmPerSec)} cm/s</div>}</div>
                <div className="mt-3 grid grid-cols-3 gap-2"><button className="rounded bg-[#238636] px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={!selectedDynamicObject || selectedDynamicObject.status === "moving"} onClick={async () => { if (!selectedDynamicObject) return; const result = await api.controlDynamicObject({ id: selectedDynamicObject.id, action: "start", speedCmPerSec: dynSpeed }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Dynamic object started."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Start</button><button className="rounded bg-[#8b949e] px-3 py-2 font-semibold text-black disabled:opacity-40" disabled={!selectedDynamicObject || selectedDynamicObject.status === "stopped"} onClick={async () => { if (!selectedDynamicObject) return; const result = await api.controlDynamicObject({ id: selectedDynamicObject.id, action: "stop" }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Dynamic object stopped."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Stop</button><button className="rounded bg-[#1f6feb] px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={!selectedDynamicObject} onClick={async () => { if (!selectedDynamicObject) return; const result = await api.controlDynamicObject({ id: selectedDynamicObject.id, action: "update-speed", speedCmPerSec: dynSpeed }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult(`Dynamic object speed set to ${dynSpeed} cm/s.`); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Apply Speed</button></div>
                <div className="mt-4 border-t border-[#263241] pt-3"><div className="flex items-center justify-between gap-2"><h4 className="font-semibold">Dynamic Objects</h4><div className="flex items-center gap-2"><span className="metric-label">{state.navigation.obstacles.length} total</span><button className="rounded border border-[#da3633] px-2 py-1 text-xs font-semibold text-[#ffa198] disabled:opacity-40" disabled={!state.navigation.obstacles.some((object) => object.status === "moving" || object.status === "blocked")} onClick={async () => { const result = await api.stopAllDynamicObjects(); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("All dynamic objects stopped."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Stop All</button></div></div><div className="mt-2 max-h-56 space-y-2 overflow-auto">{state.navigation.obstacles.length === 0 && <div className="text-sm text-[#8b949e]">Create a drawn route to add the first object.</div>}{state.navigation.obstacles.map((object) => <div key={object.id} className={`rounded border p-2 text-sm ${object.id === selectedDynamicId ? "border-[#58a6ff] bg-[#19324d]" : "border-[#263241]"}`}><button className="flex w-full items-center justify-between text-left" onClick={() => { setSelectedDynamicId(object.id); setDynSpeed(object.speedCmPerSec); }}><span><span className="mr-2 inline-block h-3 w-3 rounded-full" style={{ backgroundColor: object.color ?? dynamicColor(object.id) }} />{object.name}</span><span className="text-[#8b949e]">{object.status}</span></button><div className="mt-1 text-xs text-[#8b949e]">{fmt(object.xCm)}, {fmt(object.yCm)} cm · {object.route.length} route cells · {fmt(object.speedCmPerSec)} cm/s{object.status === "blocked" && object.stuckSinceMs !== null ? ` · stuck ${Math.max(0, Math.floor((Date.now() - object.stuckSinceMs) / 1000))}s / reroute at 3s` : ""}</div><div className="mt-2 grid grid-cols-3 gap-2"><button className="rounded border border-[#263241] px-2 py-1 disabled:opacity-40" disabled={object.status === "moving"} onClick={async () => { const result = await api.controlDynamicObject({ id: object.id, action: "start", speedCmPerSec: object.speedCmPerSec }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult(`${object.name} started.`); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Start</button><button className="rounded border border-[#263241] px-2 py-1 disabled:opacity-40" disabled={object.status === "stopped"} onClick={async () => { const result = await api.controlDynamicObject({ id: object.id, action: "stop" }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult(`${object.name} stopped.`); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Stop</button><button className="rounded border border-[#da3633] px-2 py-1 text-[#ffa198]" onClick={async () => { const result = await api.controlDynamicObject({ id: object.id, action: "delete" }); if (result.ok) { applyNavigationResponse(result.data); if (selectedDynamicId === object.id) setSelectedDynamicId(null); setCommandResult(`${object.name} deleted.`); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Delete</button></div></div>)}</div></div>
              </div>
              <div className="panel p-4"><h3 className="font-semibold">Safety and Motion</h3><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-sm">Nominal cm/s<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={nominalSpeed} onChange={(e) => setNominalSpeed(Number(e.target.value))} /></label><label className="text-sm">Caution cm/s<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={cautionSpeed} onChange={(e) => setCautionSpeed(Number(e.target.value))} /></label><label className="text-sm">Hard stop cm<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={hardClearance} onChange={(e) => setHardClearance(Number(e.target.value))} /></label><label className="text-sm">Soft slow cm<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={softClearance} onChange={(e) => setSoftClearance(Number(e.target.value))} /></label><label className="col-span-2 text-sm">Stuck reroute ms<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={stuckMs} onChange={(e) => setStuckMs(Number(e.target.value))} /></label></div><button className="mt-3 w-full rounded bg-[#238636] px-3 py-2 font-semibold" onClick={async () => { const result = await api.navigationConfig({ nominalSpeedCmPerSec: nominalSpeed, cautionSpeedCmPerSec: cautionSpeed, hardClearanceCm: hardClearance, softClearanceCm: softClearance, stuckBeforeReplanMs: stuckMs }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Safety settings applied."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Apply Safety Settings</button></div>
              <div className="grid gap-3 md:grid-cols-2"><div className="panel p-3"><h3 className="font-semibold">Static Object Map</h3><LayerMap title="Static occupied cells" cells={state.navigation.staticMap.cells} state={state} /></div><div className="panel p-3"><h3 className="font-semibold">Dynamic Map</h3><LayerMap title="Dynamic objects + observed tracks" cells={state.navigation.dynamicMap.cells} state={state} /></div></div>
            </div>
            <details className="panel p-4" data-testid="configure-static-layout"><summary className="cursor-pointer font-semibold">Advanced static layout settings</summary><div className="mt-4 grid gap-3 md:grid-cols-2"><label className="text-sm">World W<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={worldWidth} onChange={(e) => setWorldWidth(Number(e.target.value))} /></label><label className="text-sm">World H<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={worldHeight} onChange={(e) => setWorldHeight(Number(e.target.value))} /></label><label className="text-sm">Grid cm<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={gridCell} onChange={(e) => setGridCell(Number(e.target.value))} /></label><label className="text-sm">Object name<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" value={rectName} onChange={(e) => setRectName(e.target.value)} /></label><label className="text-sm">X<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={rectX} onChange={(e) => setRectX(Number(e.target.value))} /></label><label className="text-sm">Y<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={rectY} onChange={(e) => setRectY(Number(e.target.value))} /></label><label className="text-sm">Width<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={rectW} onChange={(e) => setRectW(Number(e.target.value))} /></label><label className="text-sm">Height<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" value={rectH} onChange={(e) => setRectH(Number(e.target.value))} /></label></div><button className="mt-3 rounded bg-[#1f6feb] px-3 py-2 font-semibold" onClick={async () => { const object: StaticObject = { kind: "rect", id: `rect-${Date.now()}`, name: rectName, xCm: rectX, yCm: rectY, widthCm: rectW, heightCm: rectH }; const result = await api.layout({ widthCm: worldWidth, heightCm: worldHeight, gridCellCm: gridCell, roverStart: state.navigation.world.roverStart, target: state.navigation.target, staticObjects: [...state.navigation.world.staticObjects, object] }); if (result.ok) { applyNavigationResponse(result.data); setCommandResult("Static layout applied."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Apply Layout With Object</button>{state.navigation.world.validationErrors.length > 0 && <div className="mt-2 text-sm text-[#ffa198]">{state.navigation.world.validationErrors[0]}</div>}</details>
          </div>
        )}

        {tab === "Manual Control" && (
          <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="panel p-4">
              <h2 className="font-semibold">Manual Controls</h2>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <span />
                <button data-testid="drive-forward" disabled={disabled} className="rounded bg-[#1f6feb] px-3 py-3 font-semibold disabled:opacity-40" onClick={() => submitCommand(leftPwm, rightPwm)}>Forward</button>
                <span />
                <button disabled={disabled} className="rounded bg-[#30363d] px-3 py-3 font-semibold disabled:opacity-40" onClick={() => submitCommand(-leftPwm, rightPwm)}>Left</button>
                <button data-testid="drive-stop" disabled={!state.transport.connected} className="rounded bg-[#8b949e] px-3 py-3 font-semibold text-black disabled:opacity-40" onClick={async () => handleCommandResult(await api.command({ type: "stop" }))}>Stop</button>
                <button disabled={disabled} className="rounded bg-[#30363d] px-3 py-3 font-semibold disabled:opacity-40" onClick={() => submitCommand(leftPwm, -rightPwm)}>Right</button>
                <span />
                <button disabled={disabled} className="rounded bg-[#30363d] px-3 py-3 font-semibold disabled:opacity-40" onClick={() => submitCommand(-leftPwm, -rightPwm)}>Backward</button>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="text-sm">Left PWM<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" min={-255} max={255} value={leftPwm} onChange={(e) => setLeftPwm(Number(e.target.value))} /></label>
                <label className="text-sm">Right PWM<input className="mt-1 w-full rounded border border-[#263241] bg-[#0d1117] p-2" type="number" min={-255} max={255} value={rightPwm} onChange={(e) => setRightPwm(Number(e.target.value))} /></label>
              </div>
              <button data-testid="emergency-stop" className="mt-4 w-full rounded bg-[#da3633] px-3 py-3 font-bold text-white" onClick={async () => handleCommandResult(await api.command({ type: "emergency-stop" }))}>Emergency Stop</button>
              <button className="mt-2 w-full rounded border border-[#263241] px-3 py-2" onClick={async () => handleCommandResult(await api.command({ type: "clear-emergency-stop" }))}>Clear Emergency Latch</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Stat label="Command result" value={commandResult} testId="command-result" />
              <Stat label="Transport status" value={state.transport.status} />
              <Stat label="Applied left PWM" value={String(state.motors.leftAppliedPwm)} />
              <Stat label="Applied right PWM" value={String(state.motors.rightAppliedPwm)} />
              {sensorCards}
            </div>
          </div>
        )}

        {tab === "Diagnostics & Testing" && (
          <Diagnostics state={state} metrics={metrics} setState={setState} setCommandResult={setCommandResult} refresh={refresh} />
        )}
      </section>
    </main>
  );
}

function downloadRunReport(state: RobotState): void {
  const decisions = [...state.navigation.decisionLog].sort((a, b) => a.timestampMs - b.timestampMs);
  const decisionDistanceCm = decisions.slice(1).reduce((total, entry, index) => total + Math.hypot(entry.pose.xCm - decisions[index].pose.xCm, entry.pose.yCm - decisions[index].pose.yCm), 0);
  const elapsedSec = decisions.length > 1 ? (decisions[decisions.length - 1].timestampMs - decisions[0].timestampMs) / 1000 : 0;
  const waitingSec = decisions.slice(0, -1).reduce((total, entry, index) => {
    const next = decisions[index + 1];
    return total + (["WAIT", "VERIFY_CLEAR", "REPLAN"].includes(entry.action) ? (next.timestampMs - entry.timestampMs) / 1000 : 0);
  }, 0);
  const stopStartCycles = decisions.filter((entry) => entry.action === "RESUME" || entry.action === "MOVE_NOMINAL").length;
  const report = {
    reportType: "cade-rover-run",
    generatedAt: new Date().toISOString(),
    finalState: {
      navigationStatus: state.navigation.status,
      cadeState: state.navigation.cadeState,
      finalPose: state.robot.pose,
      target: state.navigation.target,
      replanCount: state.navigation.replanCount,
      trajectoryPoints: state.navigation.trajectory.length,
      cadeDecision: state.navigation.decision,
      rmaapAssessment: state.navigation.adaptiveDecision ?? null,
      dynamicInteractions: state.navigation.dynamicInteractions ?? [],
      navigationConfig: state.navigation.config,
      battery: state.battery
    },
    metrics: {
      outcome: state.navigation.status,
      elapsedSec: Number(elapsedSec.toFixed(3)),
      decisionTransitionDistanceCm: Number(decisionDistanceCm.toFixed(3)),
      waitingSec: Number(waitingSec.toFixed(3)),
      stopStartCycles,
      replanCount: state.navigation.replanCount,
      testBatteryEnergyUsedJoules: Number(state.battery.usedJoules.toFixed(3)),
      testBatteryEnergyRemainingJoules: Number(state.battery.remainingJoules.toFixed(3)),
      estimationBasis: "Deterministic test-battery model. Energy is accumulated from telemetry elapsed time and applied PWM: 2 W idle plus up to 18 W motor load. Values are joules for repeatable simulator comparisons, not electrical measurements from hardware.",
      comparisonMode: state.navigation.config.strategy === "cade" ? "CADE adaptive navigation" : "Industry fixed-rule baseline: wait, then reroute after 3 seconds"
    },
    completedRuns: state.navigation.runHistory,
    activeRun: state.navigation.activeRun,
    decisionLog: state.navigation.decisionLog
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cade-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function SceneRecordingPanel({ state, setState, setCommandResult }: { state: RobotState; setState: (state: RobotState) => void; setCommandResult: (message: string) => void }) {
  return <div className="panel p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Scene Recording</h2><div className="mt-1 text-sm text-[#8b949e]">Save the current map, target, navigation settings, and dynamic routes. Replay returns the rover and every dynamic object to their recorded starts.</div></div><div className="metric-label">{state.navigation.recording ? "RECORDING" : state.navigation.lastRecording ? "READY TO REPLAY" : "NOT RECORDED"}</div></div><div className="mt-3 grid grid-cols-3 gap-2"><button className="rounded bg-[#da3633] px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={Boolean(state.navigation.recording)} onClick={async () => { const result = await api.startRecording(); if (result.ok) { setState(result.data); setCommandResult("Scene recording started."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Record Scene</button><button className="rounded border border-[#263241] px-3 py-2 font-semibold disabled:opacity-40" disabled={!state.navigation.recording} onClick={async () => { const result = await api.stopRecording(); if (result.ok) { setState(result.data); setCommandResult("Scene recording saved."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Stop Recording</button><button className="rounded bg-[#1f6feb] px-3 py-2 font-semibold text-white disabled:opacity-40" disabled={!state.navigation.lastRecording && !state.navigation.recording} onClick={async () => { const result = await api.replayRecording(); if (result.ok) { setState(result.data); setCommandResult("Recorded scene replayed: rover and dynamic objects reset to start."); } else setCommandResult(`${result.error.code}: ${result.error.message}`); }}>Replay Scene</button></div></div>;
}

function LogPanel({ state, commandResult }: { state: RobotState; commandResult: string }) {
  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Rover Decision Log</h2>
        <button className="rounded border border-[#58a6ff] px-3 py-1.5 text-sm font-semibold text-[#58a6ff]" onClick={() => downloadRunReport(state)}>Download Run Report</button>
      </div>
      <div className="mt-2 text-sm" data-testid="command-result">{commandResult}</div>
      {state.navigation.activeRun && <div className="mt-3 rounded border border-[#58a6ff] bg-[#111d2b] p-3 text-sm"><div className="metric-label">Current run energy</div><div className="mt-1 font-semibold">{fmt(Math.max(0, state.navigation.activeRun.startBatteryJoules - state.battery.remainingJoules), " J")} used</div><div className="mt-1 text-xs text-[#8b949e]">{state.navigation.activeRun.strategy === "cade" ? "CADE adaptive" : "Fixed-rule baseline"} · {fmt(state.battery.remainingJoules, " J", 0)} battery remaining</div></div>}
      <div className="mt-3 rounded border border-[#263241] bg-[#0d1117] p-3 text-sm">
        <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">Run Energy History</h3><span className="metric-label">{state.navigation.runHistory.length} completed</span></div>
        {state.navigation.runHistory.length === 0 ? <div className="mt-2 text-[#8b949e]">Finished or operator-stopped runs will appear here.</div> : <div className="mt-2 max-h-48 space-y-2 overflow-auto">{state.navigation.runHistory.map((run) => <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#263241] pt-2"><div><strong>{run.outcome.toUpperCase()}</strong> · {run.strategy === "cade" ? "CADE" : "Fixed rule"}<div className="text-xs text-[#8b949e]">{fmt(run.durationSec, " s")} · {fmt(run.distanceCm, " cm")} · {run.replanCount} replans · {run.decisionCount} decisions</div></div><div className="text-right"><strong>{fmt(run.energyUsedJoules, " J")}</strong><div className="text-xs text-[#8b949e]">{new Date(run.endedAtMs).toLocaleTimeString()}</div></div></div>)}</div>}
      </div>
      <div className="mt-4 max-h-[340px] space-y-2 overflow-auto" data-testid="diagnostic-log">
        {state.navigation.decisionLog.length === 0 && <div className="text-[#8b949e]">No rover decisions have been recorded yet.</div>}
        {state.navigation.decisionLog.map((entry) => (
          <div key={entry.id} className="rounded border border-[#263241] p-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[#f2cc60]">{entry.action}</span>
              <span className="text-[#8b949e]">{new Date(entry.timestampMs).toLocaleTimeString()}</span>
            </div>
            <div className="mt-1 text-[#8b949e]">Pose: {fmt(entry.pose.xCm)} cm, {fmt(entry.pose.yCm)} cm, heading {fmt(entry.pose.thetaDeg)} deg · PWM {entry.leftPwm}/{entry.rightPwm}</div>
            <div className="mt-1">{entry.reason}</div>
            {entry.report ? <details className="mt-2 border-t border-[#263241] pt-2 text-xs text-[#8b949e]">
              <summary className="cursor-pointer font-semibold text-[#58a6ff]">CADE decision report</summary>
              <div className="mt-2 rounded border border-[#263241] bg-[#0d1117] p-2"><strong>Decision flow:</strong> {entry.report.transitionExplanation}</div>
              <div className="mt-2"><strong>Policy:</strong> {entry.report.strategy === "cade" ? "CADE motion-aware adaptive navigation" : "Fixed rule-based baseline"}</div>
              <div className="mt-2 space-y-1"><div><strong>Safety:</strong> {entry.report.safetyAssessment}</div><div><strong>Avoidance:</strong> {entry.report.avoidanceAssessment}</div><div><strong>Efficiency:</strong> {entry.report.efficiencyAssessment}</div><div><strong>Goal:</strong> {entry.report.goalProgressAssessment}</div></div>
              <div className="mt-2 space-y-1">{entry.report.alternatives.map((option, index) => <div key={`${option.action}-${index}`}><strong>{option.action} ({option.status}):</strong> {option.reason}{option.energyJoules !== null ? ` Estimate: ${fmt(option.energyJoules, " J")} / ${fmt(option.expectedTimeSec, " s")}.` : ""}</div>)}</div>
            </details> : <div className="mt-2 text-xs text-[#8b949e]">Detailed CADE report is available for decisions recorded after the backend update.</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Diagnostics({
  state,
  metrics,
  setState,
  setCommandResult,
  refresh
}: {
  state: RobotState;
  metrics: RuntimeMetrics | null;
  setState: (state: RobotState) => void;
  setCommandResult: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  const scenarios: StubScenario[] = ["normal", "missing-front-sensor", "missing-multiple-sensors", "temporary-disconnect", "reconnect", "rejected-command", "reset-baseline"];
  return (
    <div className="grid gap-4 xl:grid-cols-[0.7fr_1.3fr]">
      <div className="panel p-4">
        <h2 className="font-semibold">Stub Scenarios</h2>
        <select
          data-testid="scenario-selector"
          className="mt-4 w-full rounded border border-[#263241] bg-[#0d1117] p-2"
          onChange={async (event) => {
            const result = await api.scenario(event.target.value as StubScenario);
            if (result.ok) {
              setState(result.data);
              setCommandResult(`Scenario applied: ${event.target.value}`);
              await refresh();
            } else setCommandResult(`${result.error.code}: ${result.error.message}`);
          }}
        >
          {scenarios.map((scenario) => (
            <option key={scenario} value={scenario}>{scenario}</option>
          ))}
        </select>
        <button data-testid="inject-sensor-fault" className="mt-3 w-full rounded bg-[#9e6a03] px-3 py-2 font-semibold" onClick={async () => {
          const result = await api.scenario("missing-front-sensor");
          if (result.ok) setState(result.data);
        }}>Inject Front Sensor Fault</button>
        <button data-testid="reset-stub" className="mt-3 w-full rounded bg-[#238636] px-3 py-2 font-semibold" onClick={async () => {
          const result = await api.scenario("reset-baseline");
          if (result.ok) setState(result.data);
        }}>Reset Stub</button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Stat label="API requests" value={String(metrics?.apiRequests ?? 0)} />
        <Stat label="Average handler" value={fmt(metrics?.averageHandlerMs ?? 0, " ms", 2)} />
        <Stat label="WebSocket clients" value={String(metrics?.websocketClients ?? 0)} />
        <Stat label="Command accepted" value={String(metrics?.commandAccepted ?? 0)} />
        <Stat label="Command rejected" value={String(metrics?.commandRejected ?? 0)} />
        <Stat label="Telemetry updates" value={String(metrics?.telemetryUpdates ?? 0)} />
        <Stat label="Navigation status" value={state.navigation.status} />
        <Stat label="Mapped cells" value={String(state.navigation.map.cells.length)} />
        <Stat label="Dynamic objects" value={String(state.navigation.obstacles.filter((obstacle) => obstacle.dynamic).length)} />
        <Stat label="CADE state" value={state.navigation.cadeState} />
        <Stat label="Tracks" value={String(state.navigation.tracks.length)} />
        <Stat label="Emergency latch" value={state.robot.emergencyStopLatched ? "latched" : "clear"} />
        <Stat label="Last telemetry" value={String(state.telemetry.sequence)} />
        <Stat label="Transport" value={`${state.transport.type}/${state.transport.status}`} />
      </div>
      <LogPanel state={state} commandResult={state.diagnostics.latestCommand?.message ?? "No command submitted."} />
    </div>
  );
}
