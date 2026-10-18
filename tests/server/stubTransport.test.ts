import { ManualClock } from "@/server/clock";
import { MetricsCollector } from "@/server/metrics";
import { RobotStateStore } from "@/server/state";
import { TransportManager } from "@/server/transportManager";

describe("stub lifecycle and command processing", () => {
  it("starting once and ticking produces deterministic telemetry", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    manager.start();
    clock.advance(100);
    manager.tick();
    clock.advance(100);
    manager.tick();
    expect(store.snapshot().telemetry.sequence).toBe(2);
    expect(store.snapshot().navigation.map.cells.length).toBeGreaterThan(0);
    expect(store.snapshot().robot.pose.valid).toBe(true);
  });

  it("keeps 10 Hz control telemetry while limiting complete state broadcasts to 5 Hz", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    const messages: string[] = [];
    manager.start();
    manager.onMessage((message) => messages.push(message.type));
    for (let tick = 0; tick < 6; tick += 1) {
      clock.advance(100);
      manager.tick();
    }
    expect(store.snapshot().telemetry.sequence).toBe(6);
    expect(messages.filter((type) => type === "state")).toHaveLength(4);
  });

  it("emergency-stop latch prevents further movement", async () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    manager.start();
    await manager.submit({ type: "emergency-stop" });
    const state = await manager.submit({ type: "drive", leftPwm: 80, rightPwm: 80 });
    expect(state.diagnostics.latestCommand?.accepted).toBe(false);
    expect(state.motors.leftAppliedPwm).toBe(0);
  });

  it("fault injection affects intended sensors only", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    manager.start();
    manager.setScenario("missing-front-sensor");
    manager.tick();
    const state = store.snapshot();
    expect(state.ultrasonic.front.cm).toBeNull();
    expect(state.navigation.map.cells.length).toBeGreaterThan(0);
  });

  it("starts autonomous navigation and moves toward a target", async () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    manager.start();
    store.setNavigationTarget({ xCm: 0, yCm: 80 });
    const started = manager.startNavigation();
    expect(started.navigation.status).toBe("moving");
    await manager.submit({ type: "stop" });
    expect(store.snapshot().navigation.status).toBe("stopped");
    manager.startNavigation();
    const before = started.robot.pose.yCm;
    for (let i = 0; i < 5; i += 1) {
      clock.advance(100);
      manager.tick();
    }
    const after = store.snapshot();
    expect(after.robot.pose.yCm).toBeGreaterThan(before);
    expect(after.navigation.path?.length).toBeGreaterThan(1);
  });

  it("inserts dynamic objects that can be tracked by the map", () => {
    const clock = new ManualClock();
    const store = new RobotStateStore(clock);
    const manager = new TransportManager(store, new MetricsCollector(clock), clock, false);
    manager.start();
    const state = manager.addDynamicObject();
    expect(state.navigation.obstacles.some((obstacle) => obstacle.dynamic)).toBe(true);
  });
});
