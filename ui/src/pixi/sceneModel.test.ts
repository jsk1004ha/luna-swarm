import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "../data/mock";
import { assignSeats, MAP_COLS, MAP_ROWS, seatSlots, TILE_SIZE, zones } from "../map/officeMap";
import { createOfficeCollisionGrid, findGridPath, TileReservationTable } from "./pathfinding";
import { agentsForFloor, agentVisualVariant, buildSceneModel, MAX_FLOOR_AGENTS, resolveVisualState, sceneVisualRevision } from "./sceneModel";

describe("Pixi scene model", () => {
  it("maps every visible employee to a structured department seat", () => {
    const snapshot = createMockSnapshot(30);
    const visible = new Set(snapshot.logicalAgents.filter((agent) => agent.department === "engineering").map((agent) => agent.id));
    const model = buildSceneModel(snapshot, visible);
    expect(model.width).toBe(MAP_COLS * TILE_SIZE);
    expect(model.height).toBe(MAP_ROWS * TILE_SIZE);
    expect(model.zones).toHaveLength(7);
    expect(model.agents).toHaveLength(visible.size);
    expect(model.agents.every(({ agent, x, y }) => agent.department === "engineering" && x > 0 && y > 0)).toBe(true);
  });

  it("renders all 128 logical employees when runtime and company IDs are disjoint", () => {
    const snapshot = createMockSnapshot(4);
    expect(snapshot.agents.every((agent) => agent.id.startsWith("mock-agent-"))).toBe(true);
    expect(snapshot.logicalAgents.every((agent) => agent.id.startsWith("luna-"))).toBe(true);
    const visible = new Set(snapshot.logicalAgents.map((agent) => agent.id));

    const model = buildSceneModel(snapshot, visible);

    expect(model.agents).toHaveLength(128);
    expect(model.agents).not.toHaveLength(0);
    expect(new Set(model.agents.map(({ agent }) => agent.id))).toEqual(visible);
    expect(model.agents.some(({ agent }) => agent.runtime?.taskStatus === "running")).toBe(true);
  });

  it("assigns every employee a bounded geometric marker variant", () => {
    const snapshot = createMockSnapshot(144);
    const variants = snapshot.agents.map(agentVisualVariant);
    expect(variants.every((variant) => variant >= 0 && variant < 16)).toBe(true);
    expect(new Set(variants).size).toBeGreaterThan(8);
  });

  it("renders more than one hundred employees on the company floor", () => {
    const fullCompany = createMockSnapshot(144);
    expect(agentsForFloor(fullCompany.agents, null)).toHaveLength(144);
    expect(MAX_FLOOR_AGENTS).toBeGreaterThan(100);

    const largerCompany = createMockSnapshot(256);
    const selected = largerCompany.agents.at(-1)!;
    const visible = agentsForFloor(largerCompany.agents, selected.id);
    expect(visible).toHaveLength(MAX_FLOOR_AGENTS);
    expect(visible.some((agent) => agent.id === selected.id)).toBe(true);
  });

  it("keeps department seat origins inside their zone", () => {
    for (const zone of zones) {
      expect(zone.seatOrigin.x).toBeGreaterThan(zone.x);
      expect(zone.seatOrigin.x).toBeLessThan(zone.x + zone.width);
      expect(zone.seatOrigin.y).toBeGreaterThan(zone.y);
      expect(zone.seatOrigin.y).toBeLessThan(zone.y + zone.height);
    }
  });

  it("assigns deterministic unique directional workstations regardless of input order", () => {
    const snapshot = createMockSnapshot(144);
    const first = assignSeats(snapshot.agents).map(({ agent, seatId, workstationId, facing }) => [agent.id, seatId, workstationId, facing]);
    const second = assignSeats(snapshot.agents.slice().reverse()).map(({ agent, seatId, workstationId, facing }) => [agent.id, seatId, workstationId, facing]);
    expect(second).toEqual(first);
    expect(new Set(first.map((entry) => entry[1])).size).toBe(first.length);
    expect(new Set(first.map((entry) => entry[3]))).toEqual(new Set(["north", "south", "east", "west"]));
    for (const zone of zones) {
      const occupied = assignSeats(snapshot.agents).filter((seat) => seat.zone.id === zone.id).map((seat) => seat.slotIndex);
      expect(occupied).toEqual(Array.from({ length: occupied.length }, (_, index) => index));
    }
  });

  it("aligns each seated sprite direction with its workstation axis", () => {
    const horizontal = seatSlots(zones.find((zone) => zone.id === "engineering")!);
    const vertical = seatSlots(zones.find((zone) => zone.id === "quality")!);
    expect(new Set(horizontal.map((seat) => seat.facing))).toEqual(new Set(["north", "south"]));
    expect(new Set(vertical.map((seat) => seat.facing))).toEqual(new Set(["east", "west"]));
    const engineeringColumns = zones.find((zone) => zone.id === "engineering")!.seatColumns;
    expect(horizontal.slice(0, engineeringColumns).every((seat) => seat.facing === "north")).toBe(true);
    expect(horizontal.slice(engineeringColumns, engineeringColumns * 2).every((seat) => seat.facing === "south")).toBe(true);
  });

  it("does not rebuild the Pixi floor for progress-only snapshots", () => {
    const snapshot = createMockSnapshot(144);
    const visible = new Set(snapshot.logicalAgents.map((agent) => agent.id));
    const initial = sceneVisualRevision(snapshot, visible);
    snapshot.logicalAgents[0]!.progress += 1;
    expect(sceneVisualRevision(snapshot, visible)).toBe(initial);
    snapshot.logicalAgents[0]!.activity = "blocked";
    expect(sceneVisualRevision(snapshot, visible)).not.toBe(initial);
  });

  it("maps runtime task states to explicit visual states", () => {
    const snapshot = createMockSnapshot(30);
    const agent = snapshot.agents[0]!;
    agent.runtime = { taskStatus: "ready", dependencies: [], attempts: 0, maxAttempts: 3, validationRound: 0, priority: 1, reviewStatus: "pending", auditVotes: { accept: 0, revise: 0, reject: 0 } };
    expect(resolveVisualState(agent)).toBe("walking");
    agent.runtime.taskStatus = "validating";
    expect(["reviewing", "auditing"]).toContain(resolveVisualState(agent));
    agent.runtime.taskStatus = "accepted";
    expect(resolveVisualState(agent)).toBe("accepted");
  });

  it("routes bounded employee groups to semantic company spaces without overlap", () => {
    const model = buildSceneModel(createMockSnapshot(144));
    const destinations = model.agents.reduce((counts, agent) => {
      counts.set(agent.destination, (counts.get(agent.destination) ?? 0) + 1);
      return counts;
    }, new Map<string, number>());
    expect(destinations.get("meeting") ?? 0).toBeLessThanOrEqual(6);
    expect(destinations.get("research") ?? 0).toBeLessThanOrEqual(4);
    expect(destinations.get("incident") ?? 0).toBeLessThanOrEqual(4);
    expect(destinations.get("report") ?? 0).toBeLessThanOrEqual(3);
    expect(destinations.get("waiting") ?? 0).toBeLessThanOrEqual(6);
    const finalPositions = model.agents.map((agent) => agent.path.at(-1) ?? { x: agent.x, y: agent.y });
    expect(new Set(finalPositions.map((point) => `${point.x}:${point.y}`)).size).toBe(finalPositions.length);
  });

  it("finds a reserved collision-aware grid path through room doors", () => {
    const grid = createOfficeCollisionGrid();
    const reservations = new TileReservationTable(grid.width);
    expect(reservations.reserve("agent-a", { x: 14, y: 20 })).toBe(true);
    expect(reservations.reserve("agent-b", { x: 14, y: 20 })).toBe(false);
    const path = findGridPath(grid, { x: 49, y: 34 }, { x: 12, y: 16 }, reservations, "agent-b");
    expect(path.length).toBeGreaterThan(2);
    expect(path.at(-1)).toEqual({ x: 12, y: 16 });
  });
});
