import type { ApiResponse, CommandResult, DynamicObjectConfig, DynamicObjectControlRequest, HealthResponse, NavigationConfigRequest, NavigationControlResponse, RobotCommand, RobotState, RuntimeMetrics, StubScenario, WorldConfig } from "@/shared/protocol";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000/ws";

async function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      },
      cache: "no-store"
    });
    return (await response.json()) as ApiResponse<T>;
  } catch {
    return { ok: false, error: { code: "NETWORK_ERROR", message: "Backend is unreachable." } };
  }
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  state: () => request<RobotState>("/api/robot/state"),
  metrics: () => request<RuntimeMetrics>("/api/metrics"),
  command: (command: RobotCommand) =>
    request<CommandResult>("/api/robot/commands", { method: "POST", body: JSON.stringify(command) }),
  target: (xCm: number, yCm: number) =>
    request<NavigationControlResponse>("/api/navigation/target", { method: "POST", body: JSON.stringify({ xCm, yCm }) }),
  startNavigation: () => request<NavigationControlResponse>("/api/navigation/start", { method: "POST" }),
  stopNavigation: () => request<NavigationControlResponse>("/api/navigation/stop", { method: "POST" }),
  refreshBattery: () => request<RobotState>("/api/battery/refresh", { method: "POST" }),
  startRecording: () => request<RobotState>("/api/recording/start", { method: "POST" }),
  stopRecording: () => request<RobotState>("/api/recording/stop", { method: "POST" }),
  replayRecording: () => request<RobotState>("/api/recording/replay", { method: "POST" }),
  dynamicObject: (object?: DynamicObjectConfig) =>
    request<NavigationControlResponse>("/api/navigation/dynamic-object", { method: "POST", body: JSON.stringify(object ? { object } : {}) }),
  controlDynamicObject: (control: DynamicObjectControlRequest) =>
    request<NavigationControlResponse>("/api/navigation/dynamic-object/control", { method: "POST", body: JSON.stringify(control) }),
  stopAllDynamicObjects: () => request<NavigationControlResponse>("/api/navigation/dynamic-objects/stop", { method: "POST" }),
  navigationConfig: (config: NavigationConfigRequest["config"]) =>
    request<NavigationControlResponse>("/api/navigation/config", { method: "POST", body: JSON.stringify({ config }) }),
  layout: (world: Omit<WorldConfig, "version" | "validationErrors">) =>
    request<NavigationControlResponse>("/api/layout/apply", { method: "POST", body: JSON.stringify({ world }) }),
  scenario: (scenario: StubScenario) =>
    request<RobotState>("/api/diagnostics/stub/scenario", { method: "POST", body: JSON.stringify({ scenario }) })
};
