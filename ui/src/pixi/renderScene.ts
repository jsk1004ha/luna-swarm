import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  type Application,
  type Ticker,
} from "pixi.js";
import { DEPARTMENT_META } from "../data/mock";
import {
  MAP_COLS,
  MAP_ROWS,
  TILE_SIZE,
  objects,
  seatSlots,
  zones,
  type FurnitureKind,
  type SeatFacing,
} from "../map/officeMap";
import type { Agent, DepartmentId } from "../types";
import { loadAssetWithRetry, OFFICE_ASSET_PATHS } from "./assetLoader";
import { atlasCell, buildSceneModel, standingAtlasCell, type AgentVisualState, type SceneAgent } from "./sceneModel";

const COLORS = {
  floorA: 0x0d1815, floorB: 0x101d19, commons: 0x14241f, corridor: 0x192a24, spine: 0x22362e,
  wall: 0x59675f, wallLight: 0x77857c, wallShadow: 0x050b09,
  furniture: 0x273931, furnitureTop: 0x526158, wood: 0x7a5b3d, woodLight: 0xa47b50,
  text: 0xf2eedf, muted: 0x9eaaa1, accent: 0xb8ef9f,
  danger: 0xff766d, warning: 0xe7b75d, research: 0x75bed8, review: 0xb9a1e7,
};

const STATE_COLOR: Record<AgentVisualState, number> = {
  idle: 0x829087, walking: 0x75bed8, queued: 0xe7b75d, researching: 0x75bed8,
  coding: 0x65dc9a, testing: 0xb9a1e7, reviewing: 0xb9a1e7, auditing: 0x8ca8ff,
  meeting: 0xd6b36a, reporting: 0xb8ef9f, waiting: 0xe7b75d, blocked: 0xff766d,
  accepted: 0x8bd8b0, failed: 0xff766d, cancelled: 0x7b807d,
};

interface AtlasSheet { texture: Texture; cellSize: number; key: string }
interface OfficeAtlases { standing: AtlasSheet; north: AtlasSheet; south: AtlasSheet; east: AtlasSheet }

let atlasPromise: Promise<OfficeAtlases> | null = null;
let atlasGeneration = 0;
const cellTextures = new Map<string, Texture>();

async function loadAtlases(): Promise<OfficeAtlases> {
  if (atlasPromise) return atlasPromise;
  const entries = [
    ["standing", OFFICE_ASSET_PATHS.standing, 192],
    ["north", OFFICE_ASSET_PATHS.north, 96],
    ["south", OFFICE_ASSET_PATHS.south, 96],
    ["east", OFFICE_ASSET_PATHS.east, 96],
  ] as const;
  const pending = Promise.allSettled(entries.map(async ([key, path, cellSize]) => {
    const texture = await loadAssetWithRetry(path, (url) => Assets.load<Texture>(url), { generation: atlasGeneration });
    texture.source.scaleMode = "nearest";
    return { key, texture, cellSize } satisfies AtlasSheet;
  })).then((settled) => {
    const loaded = settled.map((result) => result.status === "fulfilled" ? result.value : null);
    const fallback = loaded.find((entry) => entry !== null);
    if (!fallback) {
      const reasons = settled.map((result) => result.status === "rejected" ? String(result.reason) : "").filter(Boolean);
      throw new AggregateError(reasons, "직원 아틀라스를 하나도 불러오지 못했습니다.");
    }
    const sheet = (index: number) => loaded[index] ?? fallback;
    return { standing: sheet(0), north: sheet(1), south: sheet(2), east: sheet(3) };
  });
  atlasPromise = pending.catch((error) => {
    atlasPromise = null;
    throw error;
  });
  return atlasPromise;
}

export function resetOfficeAssetCache(): void {
  atlasPromise = null;
  atlasGeneration += 1;
  cellTextures.clear();
}

function textLabel(text: string, x: number, y: number, size = 11, color = COLORS.text, weight: "normal" | "600" = "normal") {
  const label = new Text({ text, style: { fontFamily: "Pretendard Variable, SUIT, sans-serif", fontSize: size, fontWeight: weight, fill: color, letterSpacing: 0.35 } });
  label.position.set(x, y);
  label.resolution = 1.25;
  return label;
}

function drawTilemap(layer: Graphics) {
  const width = MAP_COLS * TILE_SIZE;
  const height = MAP_ROWS * TILE_SIZE;
  layer.rect(0, 0, width, height).fill({ color: COLORS.floorA });
  layer.rect(0, 23 * TILE_SIZE, width, 10 * TILE_SIZE).fill({ color: COLORS.commons });
  layer.rect(0, 33 * TILE_SIZE, width, 3 * TILE_SIZE).fill({ color: COLORS.spine });
  for (let y = 0; y <= MAP_ROWS; y += 2) {
    layer.moveTo(0, y * TILE_SIZE).lineTo(width, y * TILE_SIZE).stroke({ color: COLORS.floorB, alpha: 0.32, width: 1 });
  }
  for (let x = 0; x <= MAP_COLS; x += 2) {
    layer.moveTo(x * TILE_SIZE, 0).lineTo(x * TILE_SIZE, height).stroke({ color: COLORS.floorB, alpha: 0.26, width: 1 });
  }
  for (let x = 0; x < MAP_COLS; x += 2) layer.rect(x * TILE_SIZE, 34 * TILE_SIZE + 7, TILE_SIZE, 2).fill({ color: COLORS.accent, alpha: 0.09 });
}

function drawZoneArchitecture(layer: Container, onSelectDepartment: (id: DepartmentId) => void) {
  zones.forEach((zone) => {
    const meta = DEPARTMENT_META[zone.id];
    const x = zone.x * TILE_SIZE;
    const y = zone.y * TILE_SIZE;
    const width = zone.width * TILE_SIZE;
    const height = zone.height * TILE_SIZE;
    const room = new Graphics().rect(x + 4, y + 4, width - 8, height - 8).fill({ color: meta.color, alpha: 0.075 });
    const topEntry = zone.entry.y === zone.y;
    const doorX = zone.entry.x * TILE_SIZE;
    const bottomY = y + height;
    room.moveTo(x, y).lineTo(x + width, y).stroke({ color: topEntry ? COLORS.wall : COLORS.wallLight, width: 5 });
    if (topEntry) {
      room.moveTo(x, y).lineTo(doorX, y).stroke({ color: COLORS.wallLight, width: 5 });
      room.moveTo(doorX + TILE_SIZE * 2, y).lineTo(x + width, y).stroke({ color: COLORS.wallLight, width: 5 });
    }
    if (!topEntry) {
      room.moveTo(x, bottomY).lineTo(doorX, bottomY).stroke({ color: COLORS.wallLight, width: 5 });
      room.moveTo(doorX + TILE_SIZE * 2, bottomY).lineTo(x + width, bottomY).stroke({ color: COLORS.wallLight, width: 5 });
    } else room.moveTo(x, bottomY).lineTo(x + width, bottomY).stroke({ color: COLORS.wallLight, width: 5 });
    room.moveTo(x, y).lineTo(x, bottomY).moveTo(x + width, y).lineTo(x + width, bottomY).stroke({ color: COLORS.wallLight, width: 5 });
    room.rect(x + 5, y + 5, width - 10, 3).fill({ color: meta.color, alpha: 0.9 });
    room.eventMode = "static";
    room.cursor = "zoom-in";
    room.on("pointertap", () => {
      onSelectDepartment(zone.id);
      window.dispatchEvent(new CustomEvent("luna:focus-zone", { detail: { x, y, width, height } }));
    });
    layer.addChild(room);
    layer.addChild(textLabel(zone.label, x + 12, y + 12, 13, COLORS.text, "600"));
    const door = new Graphics().rect(doorX + 2, zone.entry.y * TILE_SIZE - (topEntry ? 1 : 4), TILE_SIZE * 2 - 4, 5).fill({ color: meta.color, alpha: 0.65 });
    layer.addChild(door);
  });
}

function drawWorkstationPods(layer: Container) {
  zones.forEach((zone) => {
    const meta = DEPARTMENT_META[zone.id];
    const stations = new Graphics();
    const slots = seatSlots(zone);
    const grouped = new Map<number, typeof slots>();
    slots.forEach((slot, index) => {
      const row = Math.floor(index / zone.seatColumns);
      const group = zone.seatAxis === "horizontal" ? Math.floor(row / 2) : Math.floor((index % zone.seatColumns) / 2);
      grouped.set(group, [...(grouped.get(group) ?? []), slot]);
    });
    for (const pod of grouped.values()) {
      const xs = pod.map((slot) => slot.x * TILE_SIZE);
      const ys = pod.map((slot) => slot.y * TILE_SIZE);
      const left = Math.min(...xs) - 23;
      const top = Math.min(...ys) - 19;
      const right = Math.max(...xs) + 23;
      const bottom = Math.max(...ys) + 19;
      stations.roundRect(left, top, right - left, bottom - top, 8).fill({ color: meta.color, alpha: 0.035 }).stroke({ color: meta.color, alpha: 0.16, width: 1 });
    }
    for (const slot of slots) {
      const x = slot.x * TILE_SIZE;
      const y = slot.y * TILE_SIZE;
      const horizontal = slot.facing === "north" || slot.facing === "south";
      const deskWidth = horizontal ? 34 : 12;
      const deskHeight = horizontal ? 12 : 34;
      const deskX = x - deskWidth / 2 + (slot.facing === "east" ? 10 : slot.facing === "west" ? -10 : 0);
      const deskY = y - deskHeight / 2 + (slot.facing === "south" ? 10 : slot.facing === "north" ? -10 : 0);
      stations.roundRect(deskX, deskY, deskWidth, deskHeight, 2).fill({ color: COLORS.wood, alpha: 0.42 }).stroke({ color: COLORS.woodLight, alpha: 0.45, width: 1 });
      stations.rect(x - 5, y - 5, 10, 7).fill({ color: 0x172522, alpha: 0.72 }).rect(x - 3, y - 4, 6, 3).fill({ color: meta.color, alpha: 0.55 });
      stations.ellipse(x, y + 10, 13, 8).fill({ color: COLORS.wallShadow, alpha: 0.4 });
    }
    layer.addChild(stations);
  });
}

function drawFurniture(layer: Container) {
  objects.forEach((object) => {
    const x = object.x * TILE_SIZE;
    const y = object.y * TILE_SIZE;
    const width = object.width * TILE_SIZE;
    const height = object.height * TILE_SIZE;
    const item = furnitureGraphic(object.kind, x, y, width, height);
    layer.addChild(item);
    if (object.label) {
      const plaqueWidth = Math.min(width - 10, object.label.length * 7 + 14);
      const plaque = new Graphics().roundRect(x + 5, y + height - 18, plaqueWidth, 14, 3).fill({ color: 0x07110f, alpha: 0.88 }).stroke({ color: COLORS.wall, width: 1 });
      layer.addChild(plaque, textLabel(object.label, x + 11, y + height - 17, 8, COLORS.muted, "600"));
    }
  });
}

function glassRoom(item: Graphics, x: number, y: number, width: number, height: number, tint: number) {
  item.roundRect(x, y, width, height, 5).fill({ color: tint, alpha: 0.13 }).stroke({ color: COLORS.wallLight, width: 3 });
  item.moveTo(x + width * 0.68, y + height).lineTo(x + width * 0.83, y + height).stroke({ color: tint, width: 4 });
  item.rect(x + 6, y + 6, width - 12, 3).fill({ color: tint, alpha: 0.75 });
}

function furnitureGraphic(kind: FurnitureKind, x: number, y: number, width: number, height: number): Graphics {
  const item = new Graphics();
  if (kind === "meeting_room") {
    glassRoom(item, x, y, width, height, 0xd6b36a);
    item.roundRect(x + 25, y + 35, width - 50, height - 66, 18).fill({ color: COLORS.wood }).stroke({ color: COLORS.woodLight, width: 2 });
    for (let offset = 34; offset < width - 24; offset += 34) {
      item.roundRect(x + offset, y + 22, 18, 11, 4).fill({ color: COLORS.furniture });
      item.roundRect(x + offset, y + height - 32, 18, 11, 4).fill({ color: COLORS.furniture });
    }
    item.rect(x + width - 34, y + 15, 22, 13).fill({ color: 0x10201d }).stroke({ color: COLORS.research, width: 1 });
  } else if (kind === "incident_room") {
    glassRoom(item, x, y, width, height, COLORS.danger);
    item.rect(x + 14, y + 18, width - 28, 42).fill({ color: 0x0f1413 }).stroke({ color: COLORS.danger, width: 2 });
    item.moveTo(x + 22, y + 48).lineTo(x + 48, y + 30).lineTo(x + 72, y + 50).lineTo(x + width - 20, y + 24).stroke({ color: COLORS.danger, alpha: 0.82, width: 2 });
    item.rect(x + 22, y + 72, width - 44, 22).fill({ color: COLORS.furniture }).stroke({ color: COLORS.wall, width: 1 });
  } else if (kind === "library_room") {
    glassRoom(item, x, y, width, height, COLORS.research);
    for (let row = 20; row < height - 36; row += 23) {
      item.rect(x + 13, y + row + 12, width - 26, 2).fill({ color: COLORS.woodLight });
      for (let offset = 16; offset < width - 18; offset += 12) item.rect(x + offset, y + row, 5, 12).fill({ color: [0xd29b5f, COLORS.research, COLORS.review, 0x7fbf77][(offset / 12) % 4 | 0] });
    }
    item.roundRect(x + 28, y + height - 46, width - 56, 16, 5).fill({ color: COLORS.wood });
  } else if (kind === "elevator") {
    item.roundRect(x, y, width, height, 7).fill({ color: 0x08110f }).stroke({ color: COLORS.accent, width: 2 });
    item.rect(x + 9, y + 12, width - 18, height - 28).fill({ color: 0x1d3029 }).stroke({ color: COLORS.wallLight, width: 2 });
    item.rect(x + width / 2 - 1, y + 13, 2, height - 30).fill({ color: COLORS.accent, alpha: 0.5 });
    item.circle(x + width - 13, y + 14, 3).fill({ color: COLORS.accent });
  } else if (kind === "shelf") {
    item.rect(x, y, width, height).fill({ color: 0x15231f }).stroke({ color: COLORS.wall, width: 2 });
    for (let row = 9; row < height - 12; row += 18) item.rect(x + 7, y + row + 9, width - 14, 2).fill({ color: COLORS.woodLight });
  } else if (kind === "screen") {
    item.roundRect(x, y, width, height, 5).fill({ color: 0x211516 }).stroke({ color: COLORS.danger, width: 2 });
    item.rect(x + 9, y + 10, width - 18, height - 25).fill({ color: 0x0f1413 });
  } else if (kind === "table") {
    item.roundRect(x + 10, y + 12, width - 20, height - 27, (height - 27) / 2).fill({ color: COLORS.wood }).stroke({ color: COLORS.woodLight, width: 2 });
  } else if (kind === "cafe") {
    item.roundRect(x, y, width, height, 5).fill({ color: 0x1a2924 }).stroke({ color: COLORS.wall, width: 2 });
    item.rect(x + 8, y + 12, width - 16, 23).fill({ color: COLORS.wood }).stroke({ color: COLORS.woodLight, width: 2 });
    for (let offset = 18; offset < width - 10; offset += 28) item.circle(x + offset, y + 49, 7).fill({ color: 0x35483f }).stroke({ color: COLORS.wallLight, width: 1 });
    item.circle(x + width - 22, y + 22, 8).stroke({ color: COLORS.accent, width: 2 }).circle(x + width - 19, y + 22, 3).fill({ color: COLORS.accent, alpha: 0.6 });
  } else if (kind === "sofa") {
    item.roundRect(x + 5, y + 10, width - 10, height - 24, 9).fill({ color: 0x314940 }).stroke({ color: COLORS.wallLight, width: 2 });
    item.moveTo(x + width / 2, y + 11).lineTo(x + width / 2, y + height - 15).stroke({ color: 0x1c2c27, width: 2 });
  } else if (kind === "server") {
    item.rect(x, y, width, height).fill({ color: 0x101a18 }).stroke({ color: COLORS.wall, width: 2 });
    for (let row = 9; row < height - 6; row += 13) {
      item.rect(x + 5, y + row, width - 10, 8).fill({ color: 0x1e302a });
      item.circle(x + width - 8, y + row + 4, 2).fill({ color: row % 2 ? COLORS.accent : COLORS.research });
    }
  } else if (kind === "whiteboard") {
    item.rect(x, y, width, height).fill({ color: 0xd8ddd3 }).stroke({ color: COLORS.wall, width: 3 });
    item.moveTo(x + 7, y + 15).lineTo(x + width - 8, y + 15).moveTo(x + 7, y + 30).lineTo(x + width - 14, y + 30).stroke({ color: 0x687b71, width: 2 });
  } else if (kind === "plant") {
    item.rect(x + width / 2 - 5, y + height - 12, 10, 11).fill({ color: 0x79543b });
    item.circle(x + width / 2, y + 9, 9).fill({ color: 0x4f8a55 }).circle(x + width / 2 - 7, y + 15, 7).fill({ color: 0x5d9a5f }).circle(x + width / 2 + 7, y + 15, 7).fill({ color: 0x40794c });
  } else {
    item.roundRect(x, y, width, height, 5).fill({ color: 0x1c2c27 }).stroke({ color: COLORS.wall, width: 2 });
    item.roundRect(x + 8, y + 12, width - 16, 30, 5).fill({ color: COLORS.wood }).stroke({ color: COLORS.woodLight, width: 2 });
    item.arc(x + width / 2, y + 27, 10, Math.PI * 0.15, Math.PI * 1.85).stroke({ color: COLORS.accent, width: 3 });
  }
  return item;
}

function drawZoneMetrics(layer: Container, model: ReturnType<typeof buildSceneModel>) {
  model.zones.forEach((zone) => {
    const summary = model.zoneSummaries.find((item) => item.id === zone.id)!;
    const color = summary.blocked ? COLORS.danger : DEPARTMENT_META[zone.id].color;
    layer.addChild(textLabel(`${summary.active} ACTIVE · ${summary.visible}/${summary.total} FLOOR${summary.blocked ? ` · !${summary.blocked}` : ""}`, zone.x * TILE_SIZE + 12, zone.y * TILE_SIZE + 30, 9, color, "600"));
  });
}

function drawReportPath(layer: Container, model: ReturnType<typeof buildSceneModel>, enabled: boolean) {
  const path = new Graphics();
  model.reportPath.forEach((point, index) => index === 0 ? path.moveTo(point.x, point.y) : path.lineTo(point.x, point.y));
  path.stroke({ color: COLORS.accent, alpha: enabled ? 0.24 : 0.08, width: 2 });
  layer.addChild(path);
  if (!enabled) return undefined;
  const capsule = new Graphics().roundRect(-8, -4, 16, 8, 3).fill({ color: COLORS.accent, alpha: 0.95 }).rect(-3, -2, 6, 4).fill({ color: 0x1a2b25 });
  capsule.position.set(model.reportPath[0]!.x, model.reportPath[0]!.y);
  layer.addChild(capsule);
  let elapsed = (window.__lunaSimulationTime ?? 0) * 0.00004 % 1;
  return (milliseconds: number) => {
    elapsed = (elapsed + milliseconds * 0.00004) % 1;
    const segment = Math.min(model.reportPath.length - 2, Math.floor(elapsed * (model.reportPath.length - 1)));
    const local = elapsed * (model.reportPath.length - 1) - segment;
    const from = model.reportPath[segment]!;
    const to = model.reportPath[segment + 1]!;
    capsule.position.set(from.x + (to.x - from.x) * local, from.y + (to.y - from.y) * local);
  };
}

function atlasTexture(sheet: AtlasSheet, cell: number) {
  const cacheKey = `${sheet.key}:${sheet.texture.source.uid}:${cell}`;
  let texture = cellTextures.get(cacheKey);
  if (!texture) {
    texture = new Texture({ source: sheet.texture.source, frame: new Rectangle((cell % 4) * sheet.cellSize, Math.floor(cell / 4) * sheet.cellSize, sheet.cellSize, sheet.cellSize) });
    cellTextures.set(cacheKey, texture);
  }
  return texture;
}

function stateIcon(state: AgentVisualState) {
  return ({ researching: "⌕", coding: "</>", testing: "T", reviewing: "▤", auditing: "◆", meeting: "●", reporting: "▣", waiting: "⌛", queued: "…", blocked: "!", accepted: "✓", failed: "×", cancelled: "–", walking: "→", idle: "·" } as Record<AgentVisualState, string>)[state];
}

function characterEntity(scene: SceneAgent, atlases: OfficeAtlases, showBubble: boolean, animate: boolean, onSelect: (id: string) => void) {
  const { agent, facing, visualState } = scene;
  const holder = new Container();
  const stateColor = STATE_COLOR[visualState];
  const ring = new Graphics().ellipse(0, 8, 28, 18).fill({ color: stateColor, alpha: 0.035 }).ellipse(0, 8, 28, 18).stroke({ color: stateColor, width: 1, alpha: 0.38 });
  holder.addChild(ring);
  const directional = facing === "north" ? atlases.north : facing === "south" ? atlases.south : atlases.east;
  const seated = new Sprite(atlasTexture(directional, atlasCell(agent)));
  seated.anchor.set(0.5);
  seated.width = 58;
  seated.height = 58;
  if (facing === "west") seated.scale.x *= -1;
  const standing = new Sprite(atlasTexture(atlases.standing, standingAtlasCell(agent)));
  standing.anchor.set(0.5, 0.67);
  standing.width = 38;
  standing.height = 38;
  const moving = scene.path.length > 1;
  seated.visible = !moving && scene.destination === "seat";
  standing.visible = moving || scene.destination !== "seat";
  holder.addChild(seated, standing);

  if (showBubble) {
    const bubble = new Container();
    const bubbleBody = new Graphics().roundRect(-13, -37, 26, 18, 5).fill({ color: 0xf2f3e9, alpha: 0.97 }).stroke({ color: stateColor, width: 2 }).moveTo(-3, -19).lineTo(2, -14).lineTo(5, -19).fill({ color: 0xf2f3e9 });
    const icon = textLabel(stateIcon(visualState), 0, -37, visualState === "coding" ? 7 : 11, visualState === "blocked" || visualState === "failed" ? COLORS.danger : 0x14201c, "600");
    icon.anchor.set(0.5, 0);
    bubble.addChild(bubbleBody, icon);
    holder.addChild(bubble);
  }

  const showRank = ["chairman", "director", "general_manager"].includes(agent.rank);
  if (showRank) {
    const rank = agent.rank === "chairman" ? "♛" : agent.rank.split("_").map((part) => part[0]?.toUpperCase()).join("").slice(0, 2);
    const badge = new Graphics().roundRect(-25, 20, 19, 11, 3).fill({ color: agent.rank === "chairman" ? 0xb78b2b : 0x16231f }).stroke({ color: agent.rank === "chairman" ? 0xf4cf69 : DEPARTMENT_META[agent.department].color, width: 1 });
    const badgeText = textLabel(rank, -15.5, 20, 7, COLORS.text, "600");
    badgeText.anchor.set(0.5, 0);
    holder.addChild(badge, badgeText);
  }
  holder.eventMode = "static";
  holder.cursor = "pointer";
  holder.hitArea = new Rectangle(-31, -31, 62, 72);
  holder.on("pointertap", () => onSelect(agent.id));
  (holder as Container & { cullable?: boolean }).cullable = true;
  holder.position.set(scene.x, scene.y);

  if (!moving || !animate) {
    if (moving) holder.position.set(scene.path.at(-1)!.x, scene.path.at(-1)!.y);
    seated.visible = scene.destination === "seat";
    standing.visible = scene.destination !== "seat";
    if (scene.destination === "exit") holder.alpha = 0.25;
    return { holder, advance: undefined };
  }
  let segment = 0;
  let progress = 0;
  const speed = 58 + (atlasCell(agent) % 5) * 4;
  const advance = (milliseconds: number) => {
    let remaining = speed * milliseconds / 1000;
    while (remaining > 0 && segment < scene.path.length - 1) {
      const from = scene.path[segment]!;
      const to = scene.path[segment + 1]!;
      const distance = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y));
      const available = distance * (1 - progress);
      if (remaining >= available) { remaining -= available; segment += 1; progress = 0; }
      else { progress += remaining / distance; remaining = 0; }
    }
    const from = scene.path[Math.min(segment, scene.path.length - 1)]!;
    const to = scene.path[Math.min(segment + 1, scene.path.length - 1)]!;
    holder.position.set(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress);
    standing.scale.x = to.x < from.x ? -Math.abs(standing.scale.x) : Math.abs(standing.scale.x);
    if (segment >= scene.path.length - 1) {
      seated.visible = scene.destination === "seat";
      standing.visible = scene.destination !== "seat";
      if (scene.destination === "exit") holder.alpha = Math.max(0.2, holder.alpha - milliseconds * 0.001);
    }
  };
  return { holder, advance };
}

function selectionOverlay() {
  const overlay = new Container();
  overlay.label = "employee-selection";
  overlay.eventMode = "none";
  const ring = new Graphics()
    .ellipse(0, 8, 31, 21)
    .fill({ color: COLORS.accent, alpha: 0.17 })
    .ellipse(0, 8, 31, 21)
    .stroke({ color: COLORS.accent, width: 3, alpha: 1 });
  const background = new Graphics();
  const name = textLabel("", 0, 34, 11, COLORS.text, "600");
  name.anchor.set(0.5, 0);
  overlay.addChild(ring, background, name);
  return {
    overlay,
    setName(value: string) {
      name.text = value;
      background.clear()
        .roundRect(-name.width / 2 - 5, 32, name.width + 10, 17, 4)
        .fill({ color: 0x07110f, alpha: 0.94 })
        .stroke({ color: COLORS.accent, width: 1 });
    },
  };
}

export function mountHQOffice(app: Application, onSelectDepartment: (id: DepartmentId) => void) {
  const root = new Container();
  root.label = "luna-office-static";
  root.zIndex = 0;
  const tiles = new Graphics();
  drawTilemap(tiles);
  root.addChild(tiles);
  drawZoneArchitecture(root, onSelectDepartment);
  drawWorkstationPods(root);
  drawFurniture(root);
  app.stage.addChild(root);
  return { root, destroy: () => root.destroy({ children: true }) };
}

export async function renderHQScene(
  app: Application,
  snapshot: Parameters<typeof buildSceneModel>[0],
  selectedAgentId: string | null,
  visibleAgentIds: Set<string>,
  onSelect: (id: string) => void,
) {
  const atlases = await loadAtlases();
  const model = buildSceneModel(snapshot, visibleAgentIds);
  const root = new Container();
  root.label = "luna-office-dynamic";
  root.zIndex = 2;
  drawZoneMetrics(root, model);
  const reportAdvance = drawReportPath(root, model, snapshot.metrics.completedTasks > 0 || snapshot.events.some((event) => /accepted|report/.test(event.type)));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const priority = model.agents.slice().sort((left, right) =>
    Number(["blocked", "failed"].includes(right.visualState)) - Number(["blocked", "failed"].includes(left.visualState))
    || left.agent.id.localeCompare(right.agent.id));
  const animated = new Set(reducedMotion ? [] : priority.filter((scene) => scene.path.length > 1).slice(0, 24).map((scene) => scene.agent.id));
  const bubbles = new Set(priority.filter((scene) => scene.visualState !== "idle" && scene.visualState !== "walking").slice(0, 20).map((scene) => scene.agent.id));
  priority.filter((scene) => ["blocked", "failed"].includes(scene.visualState)).slice(0, 8).forEach((scene) => bubbles.add(scene.agent.id));
  const advances: Array<(milliseconds: number) => void> = [];
  const characters = new Map<string, { holder: Container; name: string }>();
  const selection = selectionOverlay();
  if (reportAdvance && !reducedMotion) advances.push(reportAdvance);
  model.agents.forEach((scene) => {
    const character = characterEntity(scene, atlases, bubbles.has(scene.agent.id), animated.has(scene.agent.id), onSelect);
    root.addChild(character.holder);
    characters.set(scene.agent.id, { holder: character.holder, name: scene.agent.name });
    if (character.advance) advances.push(character.advance);
  });
  const setSelected = (agentId: string | null) => {
    selection.overlay.parent?.removeChild(selection.overlay);
    if (!agentId) return;
    const character = characters.get(agentId);
    if (!character) return;
    selection.setName(character.name);
    character.holder.addChild(selection.overlay);
  };
  setSelected(selectedAgentId);
  app.stage.addChild(root);
  const advance = (milliseconds: number) => advances.forEach((update) => update(milliseconds));
  const tick = (ticker: Ticker) => advance(ticker.deltaMS);
  const manualAdvance = (event: Event) => advance((event as CustomEvent<{ milliseconds: number }>).detail?.milliseconds ?? 0);
  if (advances.length) {
    app.ticker.add(tick);
    window.addEventListener("luna:advance-time", manualAdvance);
  }
  return {
    root,
    model,
    setSelected,
    destroy: () => {
      if (advances.length) {
        app.ticker.remove(tick);
        window.removeEventListener("luna:advance-time", manualAdvance);
      }
      root.destroy({ children: true });
    },
  };
}
