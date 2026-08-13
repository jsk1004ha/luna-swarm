import { assignSeats, mapPixelSize, objects, reportPath, stableHash, TILE_SIZE, zones, type SeatFacing } from "../map/officeMap";
import type { Agent, DepartmentId, Snapshot } from "../types";
import { createOfficeCollisionGrid, findGridPath, TileReservationTable, type GridPoint } from "./pathfinding";

export type AgentVisualState =
  | "idle" | "walking" | "queued" | "researching" | "coding" | "testing"
  | "reviewing" | "auditing" | "meeting" | "reporting" | "waiting" | "blocked"
  | "accepted" | "failed" | "cancelled";

export interface SceneAgent {
  agent: Agent;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  facing: SeatFacing;
  visualState: AgentVisualState;
  path: Array<{ x: number; y: number }>;
  destination: "seat" | "waiting" | "research" | "meeting" | "incident" | "audit" | "report" | "exit";
}

export interface SceneZoneSummary {
  id: DepartmentId;
  total: number;
  visible: number;
  active: number;
  blocked: number;
}

export interface SceneModel {
  width: number;
  height: number;
  agents: SceneAgent[];
  zones: typeof zones;
  zoneSummaries: SceneZoneSummary[];
  objects: typeof objects;
  reportPath: Array<{ x: number; y: number }>;
}

export const MAX_FLOOR_AGENTS = 144;

export function agentsForFloor(agents: Agent[], selectedAgentId: string | null): Agent[] {
  const comparePriority = (left: Agent, right: Agent): number =>
    Number(right.id === selectedAgentId) - Number(left.id === selectedAgentId)
    || Number(right.isActive) - Number(left.isActive)
    || left.id.localeCompare(right.id);
  const buckets = zones.map((zone) => agents
    .filter((agent) => agent.department === zone.id)
    .sort(comparePriority)
    .slice(0, zone.seatColumns * zone.seatRows));
  const visible: Agent[] = [];
  let row = 0;
  while (visible.length < MAX_FLOOR_AGENTS) {
    let added = false;
    for (const bucket of buckets) {
      const agent = bucket[row];
      if (!agent) continue;
      visible.push(agent);
      added = true;
      if (visible.length === MAX_FLOOR_AGENTS) break;
    }
    if (!added) break;
    row += 1;
  }
  return visible;
}

export function sceneVisualRevision(snapshot: Snapshot, visibleAgentIds?: Set<string>): number {
  const agents = sceneRoster(snapshot)
    .filter((agent) => !visibleAgentIds || visibleAgentIds.has(agent.id))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const reportActive = snapshot.metrics.completedTasks > 0
    || snapshot.events.some((event) => /accepted|report/.test(event.type));
  let revision = stableHash(`${snapshot.run.id}:${reportActive}`);
  for (const agent of agents) {
    const visual = [
      agent.id,
      agent.department,
      agent.rank,
      agent.activity,
      agent.isActive,
      agent.runtime?.taskStatus ?? "",
      agent.avatar?.base ?? "",
    ].join(":");
    revision = Math.imul(revision ^ stableHash(visual), 16777619) >>> 0;
  }
  return revision;
}

export function buildSceneModel(snapshot: Snapshot, visibleAgentIds?: Set<string>): SceneModel {
  const size = mapPixelSize();
  const grid = createOfficeCollisionGrid();
  const reservations = new TileReservationTable(grid.width);
  const roster = sceneRoster(snapshot);
  const assignments = assignSeats(roster);
  const visibleAssignments = visibleAgentIds
    ? assignments.filter(({ agent }) => visibleAgentIds.has(agent.id))
    : assignments;
  const destinationCounts = new Map<string, number>();
  const sceneAgents = visibleAssignments.map((seat) => {
    const visualState = resolveVisualState(seat.agent);
    const home = { x: Math.round(seat.x), y: Math.round(seat.y) };
    const destinationGroup = visualState === "accepted" || visualState === "reporting"
      ? "report"
      : visualState === "queued" || visualState === "waiting"
        ? "waiting"
        : visualState;
    const destinationIndex = destinationCounts.get(destinationGroup) ?? 0;
    destinationCounts.set(destinationGroup, destinationIndex + 1);
    const movement = movementForAgent(seat.agent, visualState, home, destinationIndex);
    const target = reserveNearby(reservations, seat.agent.id, movement.target, grid.width, grid.height);
    const tilePath = movement.start.x === target.x && movement.start.y === target.y
      ? []
      : findGridPath(grid, movement.start, target, reservations, seat.agent.id);
    return {
      agent: seat.agent,
      facing: seat.facing,
      visualState,
      homeX: centerPixel(home.x),
      homeY: centerPixel(home.y),
      x: centerPixel(tilePath[0]?.x ?? target.x),
      y: centerPixel(tilePath[0]?.y ?? target.y),
      path: tilePath.map((point) => ({ x: centerPixel(point.x), y: centerPixel(point.y) })),
      destination: movement.destination,
    };
  });
  return {
    ...size,
    zones,
    objects,
    reportPath: reportPath.map((point) => ({ x: centerPixel(point.x), y: centerPixel(point.y) })),
    agents: sceneAgents,
    zoneSummaries: zones.map((zone) => {
      const all = roster.filter((agent) => agent.department === zone.id);
      return {
        id: zone.id,
        total: all.length,
        visible: sceneAgents.filter(({ agent }) => agent.department === zone.id).length,
        active: all.filter((agent) => agent.isActive).length,
        blocked: all.filter((agent) => agent.activity === "blocked").length,
      };
    }),
  };
}

/**
 * HQ is a company view, so it renders the fixed logical roster. Runtime seats
 * remain available on the snapshot for concurrency metrics, but their IDs are
 * intentionally not used as floor identities.
 */
function sceneRoster(snapshot: Snapshot): Agent[] {
  return snapshot.logicalAgents.length > 0 ? snapshot.logicalAgents : snapshot.agents;
}

export function resolveVisualState(agent: Agent): AgentVisualState {
  const status = agent.runtime?.taskStatus;
  if (status === "planned") return "queued";
  if (status === "ready") return "walking";
  if (status === "validating") return agent.department === "risk" ? "auditing" : "reviewing";
  if (status === "retry_wait") return "waiting";
  if (status === "accepted") return "accepted";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "cancelled") return "cancelled";
  if (status === "running") {
    if (agent.department === "research") return "researching";
    if (agent.department === "engineering") return "coding";
    if (agent.department === "risk" || agent.department === "quality") return "auditing";
    if (agent.department === "integration" || agent.department === "strategy") return "meeting";
    return "reporting";
  }
  if (agent.activity === "researching") return "researching";
  if (agent.activity === "reviewing") return agent.department === "quality" ? "auditing" : "reviewing";
  if (agent.activity === "working") return agent.department === "engineering" ? "coding" : "reporting";
  if (agent.activity === "waiting") return "waiting";
  if (agent.activity === "blocked") return "blocked";
  if (agent.activity === "done") return "accepted";
  return "idle";
}

function movementForAgent(agent: Agent, state: AgentVisualState, home: GridPoint, destinationIndex: number): { start: GridPoint; target: GridPoint; destination: SceneAgent["destination"] } {
  const waiting = { x: 84 + (stableHash(agent.id) % 9), y: 33 };
  const waitingSeats = [{ x: 84, y: 30 }, { x: 86, y: 30 }, { x: 89, y: 30 }, { x: 91, y: 30 }, { x: 85, y: 32 }, { x: 90, y: 32 }];
  if (state === "queued") {
    const target = waitingSeats[destinationIndex];
    return target ? { start: target, target, destination: "waiting" } : { start: home, target: home, destination: "seat" };
  }
  if (state === "walking") return { start: waiting, target: home, destination: "seat" };
  if (agent.runtime?.taskStatus === "validating") {
    if (destinationIndex < 6) return { start: home, target: { x: 80 + (destinationIndex % 6) * 2, y: 38 }, destination: "audit" };
    return { start: home, target: home, destination: "seat" };
  }
  if (state === "researching" && destinationIndex < 4) {
    return { start: home, target: [{ x: 71, y: 31 }, { x: 73, y: 31 }, { x: 76, y: 31 }, { x: 78, y: 31 }][destinationIndex]!, destination: "research" };
  }
  if (state === "meeting" && destinationIndex < 6) {
    return { start: home, target: [{ x: 31, y: 25 }, { x: 34, y: 25 }, { x: 37, y: 25 }, { x: 31, y: 31 }, { x: 34, y: 31 }, { x: 37, y: 31 }][destinationIndex]!, destination: "meeting" };
  }
  if (state === "blocked" && destinationIndex < 4) {
    return { start: home, target: [{ x: 57, y: 31 }, { x: 59, y: 31 }, { x: 62, y: 31 }, { x: 64, y: 31 }][destinationIndex]!, destination: "incident" };
  }
  if (state === "waiting" && destinationIndex < 6) {
    return { start: home, target: waitingSeats[destinationIndex]!, destination: "waiting" };
  }
  if (state === "accepted" || state === "reporting") {
    if (destinationIndex < 3) return { start: home, target: [{ x: 47, y: 31 }, { x: 49, y: 31 }, { x: 51, y: 31 }][destinationIndex]!, destination: "report" };
    return { start: home, target: home, destination: "seat" };
  }
  if (state === "cancelled") return { start: home, target: { x: 94, y: 34 }, destination: "exit" };
  return { start: home, target: home, destination: "seat" };
}

function reserveNearby(
  reservations: TileReservationTable,
  entityId: string,
  target: GridPoint,
  width: number,
  height: number,
): GridPoint {
  for (let radius = 0; radius < 5; radius += 1) {
    for (let offset = -radius; offset <= radius; offset += 1) {
      const candidates = [
        { x: target.x + offset, y: target.y - radius },
        { x: target.x + offset, y: target.y + radius },
        { x: target.x - radius, y: target.y + offset },
        { x: target.x + radius, y: target.y + offset },
      ];
      for (const point of candidates) {
        if (point.x < 1 || point.y < 1 || point.x >= width - 1 || point.y >= height - 1) continue;
        if (reservations.reserve(entityId, point)) return point;
      }
    }
  }
  reservations.reserve(entityId, target);
  return target;
}

function centerPixel(tile: number) { return tile * TILE_SIZE + TILE_SIZE / 2; }

export function hashString(value: string): number { return stableHash(value); }

export function agentVisualVariant(agent: Agent): number {
  const numeric = Number(agent.avatar?.base);
  return Number.isFinite(numeric) ? Math.abs(Math.trunc(numeric)) % 16 : hashString(agent.id) % 16;
}
