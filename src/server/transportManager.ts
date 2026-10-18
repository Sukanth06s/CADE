import type { DynamicObjectConfig, LayoutRequest, NavigationConfigRequest, NavigationTargetRequest, StubScenario, RobotCommand, RobotState, WsMessage } from "@/shared/protocol";
import type { Clock } from "./clock";
import { MetricsCollector } from "./metrics";
import { RobotStateStore } from "./state";
import { StubTransport } from "./stubTransport";
import type { RobotTransport } from "./transport";

type Listener = (message: WsMessage) => void;

export class TransportManager {
  private readonly transport: RobotTransport;
  private readonly listeners = new Set<Listener>();
  private started = false;
  private commandSequence = 0;
  private commandQueue: Promise<RobotState>;
  private lastTelemetryBroadcastMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly store: RobotStateStore,
    private readonly metrics: MetricsCollector,
    clock: Clock,
    useTimer = true
  ) {
    this.transport = new StubTransport(clock, useTimer);
    this.commandQueue = Promise.resolve(this.store.snapshot());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.transport.start({
      telemetry: (sample) => {
        this.store.applyTelemetry(sample);
        const state = this.store.advanceNavigation(0.1);
        this.metrics.trackTelemetry(sample.sequence);
        // Keep control and safety updates at 10 Hz, but limit complete-state UI snapshots
        // to 5 Hz. Commands, status changes, and navigation actions still broadcast now.
        if (sample.timestampMs - this.lastTelemetryBroadcastMs >= 200) {
          this.lastTelemetryBroadcastMs = sample.timestampMs;
          this.broadcast({ type: "state", data: state });
        }
      },
      status: (status, message) => {
        const state = this.store.setTransportStatus(status, message);
        this.broadcast({ type: "state", data: state });
      },
      event: (event) => {
        const created = this.store.addEvent(event.level, event.message);
        this.broadcast({ type: "event", data: created });
        this.broadcast({ type: "state", data: this.store.snapshot() });
      }
    });
  }

  stop(): void {
    this.transport.stop();
    this.started = false;
  }

  snapshot(): RobotState {
    return this.store.snapshot();
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    this.metrics.setWebsocketClients(this.listeners.size);
    listener({ type: "state", data: this.store.snapshot() });
    return () => {
      this.listeners.delete(listener);
      this.metrics.setWebsocketClients(this.listeners.size);
    };
  }

  submit(command: RobotCommand): Promise<RobotState> {
    this.commandQueue = this.commandQueue.catch(() => this.store.snapshot()).then(() => this.executeCommand(command));
    return this.commandQueue;
  }

  setScenario(scenario: StubScenario): RobotState {
    if (scenario === "reset-baseline") {
      this.transport.reset?.();
      const state = this.store.reset();
      this.broadcast({ type: "state", data: state });
      return state;
    }
    this.transport.setScenario?.(scenario);
    const state = this.store.snapshot();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  tick(): RobotState {
    this.transport.tick?.();
    return this.store.snapshot();
  }

  startNavigation(): RobotState {
    const state = this.store.startNavigation();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  stopNavigation(): RobotState {
    const state = this.store.stopNavigation();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  setNavigationTarget(target: NavigationTargetRequest): RobotState {
    const state = this.store.setNavigationTarget(target);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  updateNavigationConfig(request: NavigationConfigRequest): RobotState {
    const state = this.store.updateNavigationConfig(request);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  refreshTestBattery(): RobotState {
    const state = this.store.refreshTestBattery();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  startSceneRecording(): RobotState {
    const state = this.store.startSceneRecording();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  stopSceneRecording(): RobotState {
    const state = this.store.stopSceneRecording();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  replayRecordedScene(): RobotState {
    const state = this.store.replayRecordedScene();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  applyLayout(request: LayoutRequest): RobotState {
    const state = this.store.applyLayout(request);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  addDynamicObject(config?: DynamicObjectConfig): RobotState {
    const state = this.store.addDynamicObject(config);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  hasDynamicObject(id: string): boolean {
    return this.store.hasDynamicObject(id);
  }

  controlDynamicObject(id: string, action: "start" | "stop" | "update-speed" | "delete", speedCmPerSec?: number): RobotState {
    const state = this.store.controlDynamicObject(id, action, speedCmPerSec);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  stopAllDynamicObjects(): RobotState {
    const state = this.store.stopAllDynamicObjects();
    this.broadcast({ type: "state", data: state });
    return state;
  }

  private async executeCommand(command: RobotCommand): Promise<RobotState> {
    const current = this.store.snapshot();
    if (current.robot.emergencyStopLatched && command.type === "drive" && (command.leftPwm !== 0 || command.rightPwm !== 0)) {
      const result = {
        commandId: this.nextCommandId(),
        type: command.type,
        accepted: false,
        confirmed: true,
        message: "Emergency-stop latch is active. Clear it before movement.",
        timestampMs: current.timestampMs
      };
      this.metrics.trackCommand(false);
      const state = this.store.recordCommand(command, result);
      this.broadcast({ type: "state", data: state });
      return state;
    }
    const result = await this.transport.submit(this.nextCommandId(), command);
    this.metrics.trackCommand(result.accepted);
    const state = this.store.recordCommand(command, result);
    this.broadcast({ type: "state", data: state });
    return state;
  }

  private nextCommandId(): string {
    this.commandSequence += 1;
    return `cmd-${this.commandSequence}`;
  }

  private broadcast(message: WsMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
