import type { CommandResult, DiagnosticEvent, RobotCommand, StubScenario, TelemetrySample, TransportStatus, TransportType } from "@/shared/protocol";

export interface TransportCallbacks {
  telemetry(sample: TelemetrySample): void;
  status(status: TransportStatus, message?: string): void;
  event(event: Omit<DiagnosticEvent, "id" | "timestampMs">): void;
}

export interface RobotTransport {
  readonly type: TransportType;
  status(): TransportStatus;
  start(callbacks: TransportCallbacks): void;
  stop(): void;
  dispose(): void;
  submit(commandId: string, command: RobotCommand): Promise<CommandResult>;
  setScenario?(scenario: StubScenario): void;
  reset?(): void;
  tick?(): void;
}
