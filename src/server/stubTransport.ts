import type { Clock } from "./clock";
import type { RobotTransport, TransportCallbacks } from "./transport";
import type { CommandResult, RobotCommand, StubScenario, TelemetrySample, TransportStatus } from "@/shared/protocol";

const TELEMETRY_INTERVAL_MS = 100;

export class StubTransport implements RobotTransport {
  readonly type = "stub" as const;
  private callbacks: TransportCallbacks | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private currentStatus: TransportStatus = "idle";
  private telemetrySequence = 0;
  private leftPulses = 0;
  private rightPulses = 0;
  private leftPwm = 0;
  private rightPwm = 0;
  private batteryVoltage = 7.4;
  private scenario: StubScenario = "normal";
  private rejectNextCommand = false;

  constructor(private readonly clock: Clock, private readonly useTimer = true) {}

  status(): TransportStatus {
    return this.currentStatus;
  }

  start(callbacks: TransportCallbacks): void {
    if (this.disposed) return;
    this.callbacks = callbacks;
    if (this.currentStatus === "disconnected" || this.currentStatus === "error") {
      this.currentStatus = "idle";
    }
    callbacks.status(this.currentStatus, "Stub transport started.");
    if (this.useTimer && this.timer === null) {
      this.timer = setInterval(() => this.tick(), TELEMETRY_INTERVAL_MS);
    }
  }

  stop(): void {
    this.leftPwm = 0;
    this.rightPwm = 0;
    this.currentStatus = "stopped";
    this.callbacks?.status("stopped", "Stub transport stopped.");
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.callbacks = null;
  }

  async submit(commandId: string, command: RobotCommand): Promise<CommandResult> {
    const timestampMs = this.clock.now();
    if (this.disposed || this.currentStatus === "disconnected" || this.currentStatus === "error") {
      return this.result(commandId, command.type, false, false, "Transport is not connected.", timestampMs);
    }
    if (this.rejectNextCommand || this.scenario === "rejected-command") {
      this.rejectNextCommand = false;
      this.callbacks?.event({ level: "warning", message: "Stub rejected command by diagnostic scenario." });
      return this.result(commandId, command.type, false, true, "Rejected by active stub scenario.", timestampMs);
    }

    if (command.type === "drive") {
      this.leftPwm = command.leftPwm;
      this.rightPwm = command.rightPwm;
      this.currentStatus = command.leftPwm === 0 && command.rightPwm === 0 ? "idle" : "manual";
      this.callbacks?.status(this.currentStatus);
      return this.result(commandId, command.type, true, true, "Drive command accepted by stub transport.", timestampMs);
    }

    if (command.type === "stop" || command.type === "emergency-stop") {
      this.leftPwm = 0;
      this.rightPwm = 0;
      this.currentStatus = "stopped";
      this.callbacks?.status("stopped");
      return this.result(commandId, command.type, true, true, `${command.type} confirmed by stub transport.`, timestampMs);
    }

    if (command.type === "clear-emergency-stop") {
      this.currentStatus = "idle";
      this.callbacks?.status("idle");
      return this.result(commandId, command.type, true, true, "Emergency-stop latch cleared in stub.", timestampMs);
    }

    return this.result(commandId, command.type, true, true, "Stub ping acknowledged.", timestampMs);
  }

  setScenario(scenario: StubScenario): void {
    if (scenario === "reset-baseline") {
      this.reset();
      return;
    }
    this.scenario = scenario;
    if (scenario === "temporary-disconnect") {
      this.leftPwm = 0;
      this.rightPwm = 0;
      this.currentStatus = "disconnected";
      this.callbacks?.status("disconnected", "Stub temporary disconnect scenario active.");
      return;
    }
    if (scenario === "reconnect") {
      this.currentStatus = "idle";
      this.scenario = "normal";
      this.callbacks?.status("idle", "Stub reconnected. Motion remains idle.");
      return;
    }
    if (scenario === "rejected-command") {
      this.rejectNextCommand = true;
    }
    this.callbacks?.event({ level: "info", message: `Stub scenario set: ${scenario}.` });
  }

  reset(): void {
    this.telemetrySequence = 0;
    this.leftPulses = 0;
    this.rightPulses = 0;
    this.leftPwm = 0;
    this.rightPwm = 0;
    this.batteryVoltage = 7.4;
    this.rejectNextCommand = false;
    this.scenario = "normal";
    this.currentStatus = "idle";
    this.callbacks?.status("idle", "Stub reset to baseline.");
  }

  tick(): void {
    if (this.disposed || this.currentStatus === "disconnected" || this.currentStatus === "error") return;
    this.telemetrySequence += 1;
    const leftDelta = Math.abs(this.leftPwm) === 0 ? 0 : Math.max(1, Math.round(Math.abs(this.leftPwm) / 60));
    const rightDelta = Math.abs(this.rightPwm) === 0 ? 0 : Math.max(1, Math.round(Math.abs(this.rightPwm) / 60));
    this.leftPulses += leftDelta;
    this.rightPulses += rightDelta;
    this.batteryVoltage = Math.max(6.8, 7.4 - this.telemetrySequence * 0.001);

    const frontBase = 60 - (this.telemetrySequence % 12);
    const ultrasonic = {
      left: 42 + (this.telemetrySequence % 5),
      front: frontBase,
      right: 48 - (this.telemetrySequence % 4)
    };

    if (this.scenario === "missing-front-sensor") ultrasonic.front = null as unknown as number;

    const sample: TelemetrySample = {
      sequence: this.telemetrySequence,
      timestampMs: this.clock.now(),
      encoders: {
        leftPulses: this.leftPulses,
        rightPulses: this.rightPulses
      },
      ultrasonic:
        this.scenario === "missing-multiple-sensors"
          ? { left: null, front: null, right: ultrasonic.right }
          : {
              left: ultrasonic.left,
              front: this.scenario === "missing-front-sensor" ? null : ultrasonic.front,
              right: ultrasonic.right
            },
      motors: {
        leftAppliedPwm: this.leftPwm,
        rightAppliedPwm: this.rightPwm
      },
      batteryVoltage: Number(this.batteryVoltage.toFixed(3)),
      transportType: "stub",
      valid: true
    };
    this.callbacks?.telemetry(sample);
  }

  private result(
    commandId: string,
    type: RobotCommand["type"],
    accepted: boolean,
    confirmed: boolean,
    message: string,
    timestampMs: number
  ): CommandResult {
    return { commandId, type, accepted, confirmed, message, timestampMs };
  }
}
