import type { Agent, DepartmentId } from "../types";

export const TILE_SIZE = 16;
export const MAP_COLS = 96;
export const MAP_ROWS = 60;

export type SeatFacing = "north" | "south" | "east" | "west";

export interface MapZone {
  id: DepartmentId;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  entry: { x: number; y: number };
  seatOrigin: { x: number; y: number };
  seatColumns: number;
  seatRows: number;
  seatGap: { x: number; y: number };
  seatAxis: "horizontal" | "vertical";
  workstationStyle: "executive" | "bench" | "library" | "studio" | "operations" | "incident" | "audit";
}

export type FurnitureKind =
  | "table" | "shelf" | "plant" | "screen" | "sofa" | "cafe" | "elevator"
  | "server" | "whiteboard" | "reception" | "meeting_room" | "incident_room" | "library_room";

export interface MapObject {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  blocksMovement?: boolean;
}

export const zones: MapZone[] = [
  { id: "executive", label: "회장실", x: 2, y: 2, width: 24, height: 21, entry: { x: 14, y: 22 }, seatOrigin: { x: 4, y: 7 }, seatColumns: 5, seatRows: 5, seatGap: { x: 4, y: 3 }, seatAxis: "horizontal", workstationStyle: "executive" },
  { id: "strategy", label: "프로젝트 총괄", x: 27, y: 2, width: 33, height: 21, entry: { x: 43, y: 22 }, seatOrigin: { x: 29.5, y: 7 }, seatColumns: 8, seatRows: 5, seatGap: { x: 3.8, y: 3 }, seatAxis: "horizontal", workstationStyle: "operations" },
  { id: "research", label: "근거 조사팀", x: 61, y: 2, width: 33, height: 21, entry: { x: 77, y: 22 }, seatOrigin: { x: 63.5, y: 7 }, seatColumns: 8, seatRows: 5, seatGap: { x: 3.8, y: 3 }, seatAxis: "horizontal", workstationStyle: "library" },
  { id: "engineering", label: "기술 개발팀", x: 2, y: 36, width: 38, height: 22, entry: { x: 21, y: 36 }, seatOrigin: { x: 5.5, y: 41 }, seatColumns: 9, seatRows: 5, seatGap: { x: 3.7, y: 3.1 }, seatAxis: "horizontal", workstationStyle: "studio" },
  { id: "integration", label: "공유 운영실", x: 41, y: 36, width: 17, height: 22, entry: { x: 49, y: 36 }, seatOrigin: { x: 43, y: 41 }, seatColumns: 4, seatRows: 6, seatGap: { x: 3.4, y: 2.8 }, seatAxis: "vertical", workstationStyle: "bench" },
  { id: "risk", label: "레드팀", x: 59, y: 36, width: 17, height: 22, entry: { x: 67, y: 36 }, seatOrigin: { x: 61, y: 41 }, seatColumns: 4, seatRows: 6, seatGap: { x: 3.4, y: 2.8 }, seatAxis: "vertical", workstationStyle: "incident" },
  { id: "quality", label: "품질 감사실", x: 77, y: 36, width: 17, height: 22, entry: { x: 85, y: 36 }, seatOrigin: { x: 79, y: 41 }, seatColumns: 4, seatRows: 6, seatGap: { x: 3.4, y: 2.8 }, seatAxis: "vertical", workstationStyle: "audit" },
];

export const objects: MapObject[] = [
  { id: "lobby", kind: "reception", x: 2, y: 25, width: 11, height: 7, label: "LUNA LOBBY", blocksMovement: true },
  { id: "cafe", kind: "cafe", x: 15, y: 25, width: 12, height: 7, label: "MOON CAFE", blocksMovement: true },
  { id: "meeting", kind: "meeting_room", x: 29, y: 24, width: 15, height: 9, label: "공유 회의실" },
  { id: "report-elevator", kind: "elevator", x: 46, y: 24, width: 7, height: 9, label: "REPORT LIFT", blocksMovement: true },
  { id: "war-room", kind: "incident_room", x: 55, y: 24, width: 12, height: 9, label: "INCIDENT ROOM" },
  { id: "library", kind: "library_room", x: 69, y: 24, width: 12, height: 9, label: "EVIDENCE LIBRARY" },
  { id: "lounge", kind: "sofa", x: 83, y: 25, width: 11, height: 7, label: "WAITING" },
  { id: "engineering-rack", kind: "server", x: 3, y: 39, width: 2, height: 16, label: "RACK", blocksMovement: true },
  { id: "quality-board", kind: "whiteboard", x: 91, y: 39, width: 2, height: 7, label: "QA", blocksMovement: true },
  { id: "plant-a", kind: "plant", x: 27, y: 30, width: 2, height: 2, blocksMovement: true },
  { id: "plant-b", kind: "plant", x: 81, y: 30, width: 2, height: 2, blocksMovement: true },
];

export const reportPath = [
  { x: 3, y: 34 }, { x: 18, y: 34 }, { x: 34, y: 34 }, { x: 49, y: 34 },
  { x: 64, y: 34 }, { x: 80, y: 34 }, { x: 93, y: 34 },
];

export interface SeatAssignment {
  agent: Agent;
  seatId: string;
  workstationId: string;
  slotIndex: number;
  x: number;
  y: number;
  facing: SeatFacing;
  zone: MapZone;
}

export function assignSeats(agents: Agent[]): SeatAssignment[] {
  return zones.flatMap((zone) => {
    const slots = seatSlots(zone);
    return agents
      .filter((agent) => agent.department === zone.id)
      .sort((left, right) => stableHash(left.id) - stableHash(right.id) || left.id.localeCompare(right.id))
      .slice(0, slots.length)
      .map((agent, slotIndex) => {
        const slot = slots[slotIndex]!;
        return {
          agent,
          zone,
          seatId: `${zone.id}-seat-${slotIndex}`,
          workstationId: `${zone.id}-pod-${Math.floor(slotIndex / Math.max(2, zone.seatAxis === "horizontal" ? zone.seatColumns * 2 : 4))}`,
          slotIndex,
          ...slot,
        };
      });
  });
}

export function seatSlots(zone: MapZone): Array<{ x: number; y: number; facing: SeatFacing }> {
  return Array.from({ length: zone.seatColumns * zone.seatRows }, (_, index) => {
    const column = index % zone.seatColumns;
    const row = Math.floor(index / zone.seatColumns);
    const facing: SeatFacing = zone.seatAxis === "horizontal"
      ? (row % 2 === 0 ? "north" : "south")
      : (column % 2 === 0 ? "east" : "west");
    return {
      x: zone.seatOrigin.x + column * zone.seatGap.x,
      y: zone.seatOrigin.y + row * zone.seatGap.y,
      facing,
    };
  });
}

export function mapPixelSize() {
  return { width: MAP_COLS * TILE_SIZE, height: MAP_ROWS * TILE_SIZE };
}

export function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
