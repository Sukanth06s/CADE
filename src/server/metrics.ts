import type { RobotState, RuntimeMetrics } from "@/shared/protocol";
import type { Clock } from "./clock";

export class MetricsCollector {
  private readonly startedAtMs: number;
  private requestCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private totalHandlerMs = 0;
  private commandCount = 0;
  private commandAccepted = 0;
  private commandRejected = 0;
  private telemetryUpdates = 0;
  private lastTelemetrySequence = 0;
  private websocketClients = 0;
  private readonly statusCounts: Record<string, number> = {};

  constructor(private readonly clock: Clock) {
    this.startedAtMs = clock.now();
  }

  trackRequest(status: number, durationMs: number): void {
    this.requestCount += 1;
    this.totalHandlerMs += durationMs;
    this.statusCounts[String(status)] = (this.statusCounts[String(status)] ?? 0) + 1;
    if (status >= 200 && status < 400) this.successCount += 1;
    else this.failureCount += 1;
  }

  trackCommand(accepted: boolean): void {
    this.commandCount += 1;
    if (accepted) this.commandAccepted += 1;
    else this.commandRejected += 1;
  }

  trackTelemetry(sequence: number): void {
    this.telemetryUpdates += 1;
    this.lastTelemetrySequence = sequence;
  }

  setWebsocketClients(count: number): void {
    this.websocketClients = count;
  }

  snapshot(state: RobotState): RuntimeMetrics {
    return {
      uptimeMs: this.clock.now() - this.startedAtMs,
      apiRequests: this.requestCount,
      apiSuccesses: this.successCount,
      apiFailures: this.failureCount,
      statusCounts: { ...this.statusCounts },
      averageHandlerMs: this.requestCount === 0 ? 0 : this.totalHandlerMs / this.requestCount,
      commandCount: this.commandCount,
      commandAccepted: this.commandAccepted,
      commandRejected: this.commandRejected,
      telemetryUpdates: this.telemetryUpdates,
      lastTelemetrySequence: this.lastTelemetrySequence,
      websocketClients: this.websocketClients,
      transport: state.transport
    };
  }
}
