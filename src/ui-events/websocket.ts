import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { isValidRunId } from "../store.js";
import type { JsonValue } from "../types.js";
import type { SwarmUiEvent } from "./schema.js";
import { UiEventHub } from "./hub.js";

export interface UiEventWebSocketOptions {
  path?: string;
  maxMessageBytes?: number;
  requireLoopback?: boolean;
  requireSameOrigin?: boolean;
  allowedOrigins?: readonly string[] | ((origin: string) => boolean);
  token?: string;
}

export interface UiEventWebSocketAttachment {
  close(): void;
}

export interface UiSnapshotMessage {
  type: "snapshot";
  mode: "replay" | "resync";
  seq: number;
  data: JsonValue | null;
}

export interface UiEventMessage {
  type: "event";
  seq: number;
  data: JsonValue;
  runId: string;
  timestamp: string;
  eventType: string;
}

export interface UiErrorMessage {
  type: "error";
  code?: "REPLAY_UNAVAILABLE";
  seq?: number;
  data: { message: string };
}

export type UiWebSocketMessage = UiSnapshotMessage | UiEventMessage | UiErrorMessage;

interface SubscribeMessage {
  type: "subscribe";
  runId: string;
  lastSeq: number;
}

export function attachUiEventWebSocketServer(
  server: Server,
  hub: UiEventHub,
  options: UiEventWebSocketOptions = {},
): UiEventWebSocketAttachment {
  const path = options.path ?? "/api/ui/events";
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxMessageBytes ?? 64 * 1024,
    perMessageDeflate: false,
  });
  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;
    try {
      assertTrustedUpgrade(request, url, options);
    } catch (error) {
      rejectUpgrade(socket, 403, error instanceof Error ? error.message : String(error));
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };
  webSocketServer.on("connection", (webSocket, request) => {
    const session = new UiEventWebSocketSession(hub, (serialized) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(serialized);
    });
    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        session.sendError("Binary WebSocket messages are not supported");
        webSocket.close(1003, "Text messages only");
        return;
      }
      try {
        session.receive(data.toString("utf8"));
      } catch (error) {
        session.sendError(error instanceof Error ? error.message : String(error));
        webSocket.close(1008, "Invalid subscription");
      }
    });
    webSocket.once("close", () => session.close());
    webSocket.once("error", () => session.close());

    const url = new URL(request.url ?? "/", "http://localhost");
    const runId = url.searchParams.get("runId");
    if (runId !== null) {
      try {
        session.subscribe(runId, parseLastSeq(url.searchParams.get("lastSeq")));
      } catch (error) {
        session.sendError(error instanceof Error ? error.message : String(error));
        webSocket.close(1008, "Invalid query subscription");
      }
    }
  });
  server.on("upgrade", onUpgrade);
  return {
    close(): void {
      server.off("upgrade", onUpgrade);
      for (const client of webSocketServer.clients) client.close(1001, "Server shutting down");
      webSocketServer.close();
    },
  };
}

export class UiEventWebSocketSession {
  private unsubscribe: (() => void) | undefined;
  private runId: string | undefined;
  private lastSeq = 0;

  constructor(
    private readonly hub: UiEventHub,
    private readonly send: (serialized: string) => void,
  ) {}

  receive(serialized: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("WebSocket message must be valid JSON");
    }
    const subscription = assertSubscribeMessage(parsed);
    this.subscribe(subscription.runId, subscription.lastSeq);
  }

  subscribe(runId: string, lastSeq = 0): void {
    if (!isValidRunId(runId)) throw new Error("Invalid runId");
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
      throw new Error("lastSeq must be a non-negative safe integer");
    }
    this.unsubscribe?.();
    this.runId = runId;
    this.lastSeq = lastSeq;
    const pending: SwarmUiEvent[] = [];
    let initializing = true;
    this.unsubscribe = this.hub.subscribe((event) => {
      if (event.runId !== this.runId) return;
      if (initializing) pending.push(event);
      else this.sendLive(event);
    });
    const current = this.hub.readReplayWindow(runId, lastSeq);
    if (current.replayStatus === "unavailable") {
      this.sendMessage({
        type: "error",
        code: "REPLAY_UNAVAILABLE",
        seq: current.lastSeq,
        data: { message: "Authoritative snapshot unavailable for event resynchronization" },
      });
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      return;
    }
    if (current.replayStatus === "resync") {
      this.sendMessage({ type: "snapshot", mode: "resync", seq: current.lastSeq, data: current.snapshot });
      this.lastSeq = current.lastSeq;
    } else {
      this.sendMessage({ type: "snapshot", mode: "replay", seq: lastSeq, data: current.snapshot });
      for (const event of current.replay) this.sendContiguous(event);
    }
    initializing = false;
    for (const event of pending.sort((left, right) => left.seq - right.seq)) this.sendLive(event);
  }

  sendError(message: string): void {
    this.sendMessage({ type: "error", data: { message } });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private sendLive(event: SwarmUiEvent): void {
    if (event.runId !== this.runId || event.seq <= this.lastSeq) return;
    if (event.seq !== this.lastSeq + 1) {
      this.resynchronize();
      return;
    }
    this.sendContiguous(event);
  }

  private sendContiguous(event: SwarmUiEvent): void {
    if (event.seq <= this.lastSeq) return;
    if (event.seq !== this.lastSeq + 1) throw new Error(`Non-contiguous UI event sequence ${event.seq} after ${this.lastSeq}`);
    this.sendEvent(event);
    this.lastSeq = event.seq;
  }

  private resynchronize(): void {
    if (!this.runId) return;
    const current = this.hub.readReplayWindow(this.runId, this.lastSeq);
    if (current.replayStatus === "unavailable") {
      this.sendMessage({
        type: "error",
        code: "REPLAY_UNAVAILABLE",
        seq: current.lastSeq,
        data: { message: "Authoritative snapshot unavailable for event resynchronization" },
      });
      return;
    }
    if (current.replayStatus === "resync") {
      this.sendMessage({ type: "snapshot", mode: "resync", seq: current.lastSeq, data: current.snapshot });
      this.lastSeq = current.lastSeq;
      return;
    }
    for (const event of current.replay) this.sendContiguous(event);
  }

  private sendEvent(event: SwarmUiEvent): void {
    this.sendMessage({
      type: "event",
      seq: event.seq,
      data: event.payload,
      runId: event.runId,
      timestamp: event.timestamp,
      eventType: event.type,
    });
  }

  private sendMessage(message: UiWebSocketMessage): void {
    this.send(JSON.stringify(message));
  }
}

function assertSubscribeMessage(value: unknown): SubscribeMessage {
  if (!isRecord(value) || value.type !== "subscribe") throw new Error("Expected a subscribe message");
  if (typeof value.runId !== "string" || !isValidRunId(value.runId)) throw new Error("Invalid runId");
  return { type: "subscribe", runId: value.runId, lastSeq: parseLastSeq(value.lastSeq) };
}

function parseLastSeq(value: unknown): number {
  const normalized = typeof value === "string" && value !== "" ? Number(value) : value ?? 0;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new Error("lastSeq must be a non-negative safe integer");
  }
  return normalized as number;
}

function assertTrustedUpgrade(
  request: IncomingMessage,
  url: URL,
  options: UiEventWebSocketOptions,
): void {
  if (options.requireLoopback !== false) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new Error("UI event WebSocket only accepts loopback clients");
    }
    if (!isTrustedLoopbackAuthority(request.headers.host, request.socket.localPort)) {
      throw new Error("WebSocket Host does not match the loopback UI server");
    }
  }
  const origin = request.headers.origin;
  if (options.requireSameOrigin === true) {
    if (!origin || !isSameOrigin(request, origin)) {
      throw new Error("WebSocket Origin does not match the UI server");
    }
  }
  if (options.allowedOrigins !== undefined) {
    if (!origin) throw new Error("WebSocket Origin is required");
    const allowed = typeof options.allowedOrigins === "function"
      ? options.allowedOrigins(origin)
      : options.allowedOrigins.includes(origin);
    if (!allowed) throw new Error("WebSocket Origin is not allowed");
  }
  if (options.token !== undefined) {
    const authorization = request.headers.authorization;
    const provided = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : url.searchParams.get("token") ?? "";
    if (!secureEqual(provided, options.token)) throw new Error("Invalid WebSocket token");
  }
}

function isTrustedLoopbackAuthority(authority: string | undefined, localPort: number | undefined): boolean {
  if (!authority || !localPort) return false;
  try {
    const url = new URL(`http://${authority}`);
    const authorityPort = url.port ? Number(url.port) : 80;
    return isLoopbackAddress(url.hostname) && authorityPort === localPort;
  } catch {
    return false;
  }
}

function isSameOrigin(request: IncomingMessage, origin: string): boolean {
  const authority = request.headers.host;
  const localPort = request.socket.localPort;
  if (!authority || !localPort) return false;
  try {
    const originUrl = new URL(origin);
    const authorityUrl = new URL(`http://${authority}`);
    const originPort = originUrl.port ? Number(originUrl.port) : 80;
    const authorityPort = authorityUrl.port ? Number(authorityUrl.port) : 80;
    return originUrl.protocol === "http:"
      && originUrl.hostname.toLowerCase() === authorityUrl.hostname.toLowerCase()
      && originPort === authorityPort
      && originPort === localPort;
  } catch {
    return false;
  }
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const address = value.toLowerCase();
  return address === "::1" || address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("::ffff:127.") || /^127(?:\.\d{1,3}){3}$/.test(address);
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end([
    `HTTP/1.1 ${status} Forbidden`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
