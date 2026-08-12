import { MAP_COLS, MAP_ROWS, objects, zones } from "../map/officeMap";

export interface GridPoint { x: number; y: number }

export interface CollisionGrid {
  width: number;
  height: number;
  blocked: Uint8Array;
}

export class TileReservationTable {
  private readonly byTile = new Map<number, string>();
  private readonly byEntity = new Map<string, number>();

  constructor(private readonly width: number) {}

  reserve(entityId: string, point: GridPoint): boolean {
    const key = point.y * this.width + point.x;
    const owner = this.byTile.get(key);
    if (owner && owner !== entityId) return false;
    const previous = this.byEntity.get(entityId);
    if (previous !== undefined && previous !== key) this.byTile.delete(previous);
    this.byTile.set(key, entityId);
    this.byEntity.set(entityId, key);
    return true;
  }

  isReserved(point: GridPoint, exceptEntityId?: string): boolean {
    const owner = this.byTile.get(point.y * this.width + point.x);
    return owner !== undefined && owner !== exceptEntityId;
  }

  release(entityId: string): void {
    const key = this.byEntity.get(entityId);
    if (key !== undefined) this.byTile.delete(key);
    this.byEntity.delete(entityId);
  }
}

export function createOfficeCollisionGrid(): CollisionGrid {
  const grid: CollisionGrid = { width: MAP_COLS, height: MAP_ROWS, blocked: new Uint8Array(MAP_COLS * MAP_ROWS) };
  for (const zone of zones) {
    for (let x = zone.x; x < zone.x + zone.width; x += 1) {
      block(grid, x, zone.y);
      block(grid, x, zone.y + zone.height - 1);
    }
    for (let y = zone.y; y < zone.y + zone.height; y += 1) {
      block(grid, zone.x, y);
      block(grid, zone.x + zone.width - 1, y);
    }
    unblock(grid, zone.entry.x, zone.entry.y);
    unblock(grid, zone.entry.x + 1, zone.entry.y);
  }
  for (const object of objects) {
    if (!object.blocksMovement) continue;
    for (let y = object.y; y < object.y + object.height; y += 1) {
      for (let x = object.x; x < object.x + object.width; x += 1) block(grid, x, y);
    }
  }
  return grid;
}

export function findGridPath(
  grid: CollisionGrid,
  start: GridPoint,
  goal: GridPoint,
  reservations?: TileReservationTable,
  entityId?: string,
): GridPoint[] {
  if (!inside(grid, start) || !inside(grid, goal)) return [];
  const startKey = keyOf(grid, start);
  const goalKey = keyOf(grid, goal);
  const size = grid.width * grid.height;
  const cameFrom = new Int32Array(size).fill(-1);
  const gScore = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const closed = new Uint8Array(size);
  const open = new MinHeap();
  gScore[startKey] = 0;
  open.push(startKey, manhattan(start, goal));
  while (open.size > 0) {
    const currentKey = open.pop()!;
    if (closed[currentKey]) continue;
    if (currentKey === goalKey) return reconstruct(grid, cameFrom, currentKey);
    closed[currentKey] = 1;
    const current = pointOf(grid, currentKey);
    for (const next of neighbors(current)) {
      if (!inside(grid, next)) continue;
      const nextKey = keyOf(grid, next);
      if (closed[nextKey]) continue;
      const isGoal = nextKey === goalKey;
      if (!isGoal && grid.blocked[nextKey]) continue;
      if (!isGoal && reservations?.isReserved(next, entityId)) continue;
      const tentative = gScore[currentKey]! + 1;
      if (tentative >= gScore[nextKey]!) continue;
      cameFrom[nextKey] = currentKey;
      gScore[nextKey] = tentative;
      open.push(nextKey, tentative + manhattan(next, goal));
    }
  }
  return [];
}

function reconstruct(grid: CollisionGrid, cameFrom: Int32Array, key: number): GridPoint[] {
  const path: GridPoint[] = [pointOf(grid, key)];
  while (cameFrom[key] !== -1) {
    key = cameFrom[key]!;
    path.push(pointOf(grid, key));
  }
  return path.reverse();
}

function neighbors(point: GridPoint): GridPoint[] {
  return [
    { x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 },
  ];
}

function block(grid: CollisionGrid, x: number, y: number) {
  if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) grid.blocked[y * grid.width + x] = 1;
}

function unblock(grid: CollisionGrid, x: number, y: number) {
  if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) grid.blocked[y * grid.width + x] = 0;
}

function inside(grid: CollisionGrid, point: GridPoint) {
  return point.x >= 0 && point.y >= 0 && point.x < grid.width && point.y < grid.height;
}

function keyOf(grid: CollisionGrid, point: GridPoint) { return point.y * grid.width + point.x; }
function pointOf(grid: CollisionGrid, key: number): GridPoint { return { x: key % grid.width, y: Math.floor(key / grid.width) }; }
function manhattan(left: GridPoint, right: GridPoint) { return Math.abs(left.x - right.x) + Math.abs(left.y - right.y); }

class MinHeap {
  private readonly values: Array<{ key: number; score: number }> = [];
  get size() { return this.values.length; }

  push(key: number, score: number) {
    const item = { key, score };
    this.values.push(item);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.score <= score) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = item;
  }

  pop(): number | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first) return undefined;
    if (this.values.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        const child = right < this.values.length && this.values[right]!.score < this.values[left]!.score ? right : left;
        if (this.values[child]!.score >= last.score) break;
        this.values[index] = this.values[child]!;
        index = child;
      }
      this.values[index] = last;
    }
    return first.key;
  }
}
