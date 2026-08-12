import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { isValidRunId } from "../store.js";
import {
  getDashboardSnapshot,
  listDashboardRuns,
  type DashboardDataOptions,
  type DashboardRunSummary,
  type DashboardSnapshot,
} from "./data.js";
import {
  uiControlCommandSchema,
  type UiControlCommand,
  type UiControlResult,
} from "../ui-server/control-schema.js";

export interface DashboardServerOptions extends DashboardDataOptions {
  port?: number;
  host?: string;
  assetsDirectory?: string;
  onCommand?: (command: DashboardCommand) => Promise<DashboardCommandResult>;
  onUiControl?: (command: UiControlCommand) => Promise<UiControlResult>;
  isRunOwned?: (runId: string) => boolean;
  getUiControlState?: (runId: string) => Promise<unknown>;
  listUiRuns?: () => Promise<DashboardRunSummary[]>;
  getUiSnapshot?: (runId?: string) => Promise<DashboardSnapshot>;
  accessToken?: string;
}

export interface DashboardCommand {
  action: "intervene" | "resume" | "start";
  text?: string;
  mock: boolean;
  requestId?: string;
  runId?: string;
  maxConcurrency?: number;
}

export interface DashboardCommandResult {
  accepted: boolean;
  message: string;
  runId?: string;
}

export interface DashboardServerAddress {
  host: string;
  port: number;
  url: string;
}

export interface DashboardServer {
  listen(): Promise<DashboardServerAddress>;
  address(): DashboardServerAddress | null;
  close(): Promise<void>;
  readonly server: Server;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const FAVICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#081628"/>
  <path d="M44 49A23 23 0 1 1 44 15 18 18 0 1 0 44 49Z" fill="#6ea8ff"/>
</svg>
`;

export function createDashboardServer(options: DashboardServerOptions = {}): DashboardServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4310;
  if (!isLoopbackHost(host) && !options.accessToken) {
    throw new Error("A non-loopback host UI requires --token / accessToken");
  }
  const assetsDirectory = resolve(options.assetsDirectory ?? resolve(process.cwd(), "web"));
  const streams = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/") && !isTrustedApiRequest(request, url, options.accessToken)) {
        throw new ForbiddenError("UI API access is not trusted");
      }
      if (url.pathname === "/api/ui/runs") {
        if (method !== "GET" && method !== "HEAD") {
          response.setHeader("allow", "GET, HEAD");
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const runs = options.listUiRuns
          ? await options.listUiRuns()
          : await listDashboardRuns(options);
        sendJson(response, 200, runs.map((run) => {
          const owned = options.isRunOwned?.(run.id) ?? options.demo === true;
          return {
            ...run,
            ownership: owned ? "owned" : options.demo === true ? "demo" : "external",
            readOnly: !owned,
          };
        }), method === "HEAD");
        return;
      }
      if (url.pathname === "/api/ui/snapshot") {
        if (method !== "GET" && method !== "HEAD") {
          response.setHeader("allow", "GET, HEAD");
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const requestedRunId = url.searchParams.get("runId") ?? options.runId;
        if (requestedRunId && !isValidRunId(requestedRunId)) {
          throw new BadRequestError("runId contains unsupported characters");
        }
        const snapshot = options.getUiSnapshot
          ? await options.getUiSnapshot(requestedRunId)
          : await getDashboardSnapshot({
              ...options,
              ...(requestedRunId ? { runId: requestedRunId } : {}),
            });
        const owned = options.isRunOwned?.(snapshot.run.id) ?? options.demo === true;
        const control = await options.getUiControlState?.(snapshot.run.id);
        sendJson(response, 200, {
          ...snapshot,
          observation: {
            mode: owned ? (options.demo === true ? "demo" : "owned") : "external-read-only",
            readOnly: !owned,
            source: snapshot.mode === "demo" ? "mock-generator" : "state.json+events.jsonl",
          },
          ...(control === undefined ? {} : { control }),
        }, method === "HEAD");
        return;
      }
      if (url.pathname === "/api/ui/control") {
        if (method !== "POST") {
          response.setHeader("allow", "POST");
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (!options.onUiControl) {
          sendJson(response, 503, { error: "UI execution control is not enabled" });
          return;
        }
        const command = await readUiControl(request);
        const result = await options.onUiControl(command);
        sendJson(response, result.accepted ? 202 : 409, result);
        return;
      }
      if (url.pathname === "/api/commands") {
        if (method !== "POST") {
          response.setHeader("allow", "POST");
          sendJson(response, 405, { error: "Method not allowed" }, method === "HEAD");
          return;
        }
        if (!options.onCommand) {
          sendJson(response, 503, { error: "Command execution is not enabled" });
          return;
        }
        assertTrustedCommandRequest(request, url, options.accessToken);
        const command = await readCommand(request);
        const result = await options.onCommand(command);
        sendJson(response, result.accepted ? 202 : 409, result);
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");
        sendJson(response, 405, { error: "Method not allowed" }, method === "HEAD");
        return;
      }
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "luna-swarm-dashboard" }, method === "HEAD");
        return;
      }
      if (url.pathname === "/favicon.ico") {
        sendFavicon(response, method === "HEAD");
        return;
      }
      if (url.pathname === "/api/snapshot") {
        const snapshot = await getDashboardSnapshot(options);
        sendJson(response, 200, snapshot, method === "HEAD");
        return;
      }
      if (url.pathname === "/api/stream") {
        if (method === "HEAD") {
          response.writeHead(200, streamHeaders());
          response.end();
          return;
        }
        response.writeHead(200, streamHeaders());
        let interval: NodeJS.Timeout | undefined;
        let closed = false;
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          if (interval) clearInterval(interval);
          streams.delete(response);
        };
        const writeEvent = (payload: string): boolean => {
          if (closed || response.destroyed || response.writableEnded) return false;
          try {
            response.write(payload);
            return true;
          } catch {
            cleanup();
            return false;
          }
        };
        response.once("close", cleanup);
        response.once("error", cleanup);
        request.once("aborted", cleanup);
        writeEvent("retry: 2000\n\n");
        streams.add(response);
        let writing = false;
        const sendSnapshot = async (): Promise<void> => {
          if (writing || closed || response.destroyed || response.writableEnded) return;
          writing = true;
          try {
            const snapshot = await getDashboardSnapshot(options);
            writeEvent(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          } catch (error) {
            writeEvent(`event: error\ndata: ${JSON.stringify({ error: errorMessage(error) })}\n\n`);
          } finally {
            writing = false;
          }
        };
        await sendSnapshot();
        if (closed) return;
        interval = setInterval(() => void sendSnapshot(), 1_000);
        interval.unref();
        return;
      }
      await serveAsset(url.pathname, assetsDirectory, response, method === "HEAD");
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof ForbiddenError
          ? 403
          : error instanceof UnsafePathError || error instanceof BadRequestError
            ? 400
            : 500;
        sendJson(response, status, { error: errorMessage(error) }, request.method === "HEAD");
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  });

  const dashboard: DashboardServer = {
    server,
    listen: () => listen(server, host, port),
    address: () => serverAddress(server),
    close: async () => {
      for (const response of streams) response.end();
      streams.clear();
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeIdleConnections();
      });
    },
  };
  return dashboard;
}

function sendFavicon(response: ServerResponse, headOnly: boolean): void {
  response.writeHead(200, {
    "cache-control": "public, max-age=86400",
    "content-length": Buffer.byteLength(FAVICON_SVG),
    "content-type": "image/svg+xml; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : FAVICON_SVG);
}

async function readCommand(request: IncomingMessage): Promise<DashboardCommand> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new BadRequestError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16 * 1024) throw new BadRequestError("Command payload is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("Command payload is not valid JSON");
  }
  if (!isRecord(value)) {
    throw new BadRequestError("Command payload must be an object");
  }
  if (value.action !== "intervene" && value.action !== "resume" && value.action !== "start") {
    throw new BadRequestError("action must be intervene, resume, or start");
  }
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (value.action !== "resume" && (text.length === 0 || text.length > 2_000)) {
    throw new BadRequestError("Command text must be between 1 and 2000 characters");
  }
  if (value.action === "resume" && text.length > 2_000) {
    throw new BadRequestError("Command text must be at most 2000 characters");
  }
  if (value.mock !== undefined && typeof value.mock !== "boolean") {
    throw new BadRequestError("mock must be a boolean");
  }
  const command: DashboardCommand = {
    action: value.action,
    mock: value.mock === true,
    ...(text ? { text } : {}),
  };
  if (value.runId !== undefined) {
    if (typeof value.runId !== "string" || !isValidRunId(value.runId)) {
      throw new BadRequestError("runId contains unsupported characters");
    }
    command.runId = value.runId;
  }
  if (value.requestId !== undefined) {
    if (
      typeof value.requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
    ) {
      throw new BadRequestError("requestId must be a UUID");
    }
    command.requestId = value.requestId;
  }
  if ((command.action === "intervene" || command.action === "resume") && !command.runId) {
    throw new BadRequestError("runId is required for an intervention or resume");
  }
  if (value.maxConcurrency !== undefined) {
    if (
      typeof value.maxConcurrency !== "number" ||
      !Number.isInteger(value.maxConcurrency) ||
      value.maxConcurrency < 1 ||
      value.maxConcurrency > 1_024
    ) {
      throw new BadRequestError("maxConcurrency must be an integer between 1 and 1024");
    }
    command.maxConcurrency = value.maxConcurrency;
  }
  return command;
}

async function readUiControl(request: IncomingMessage): Promise<UiControlCommand> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new BadRequestError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32 * 1024) throw new BadRequestError("Control payload is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("Control payload is not valid JSON");
  }
  const parsed = uiControlCommandSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestError(issue?.message ?? "Control payload is invalid");
  }
  return parsed.data;
}

async function serveAsset(
  pathname: string,
  assetsDirectory: string,
  response: ServerResponse,
  headOnly: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new UnsafePathError("Malformed URL path");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw new UnsafePathError("Unsafe asset path");
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new UnsafePathError("Unsafe asset path");
  }
  const relative = decoded === "/" ? "index.html" : segments.join("/");
  const assetPath = resolve(assetsDirectory, relative);
  if (assetPath !== assetsDirectory && !assetPath.startsWith(`${assetsDirectory}${sep}`)) {
    throw new UnsafePathError("Unsafe asset path");
  }
  let assetStat;
  try {
    assetStat = await stat(assetPath);
  } catch (error) {
    if (isNotFound(error)) {
      sendJson(response, 404, { error: "Not found" }, headOnly);
      return;
    }
    throw error;
  }
  if (!assetStat.isFile()) {
    sendJson(response, 404, { error: "Not found" }, headOnly);
    return;
  }
  const extension = extname(assetPath).toLowerCase();
  const revalidate = relative === "index.html" || extension === ".js" || extension === ".css";
  response.writeHead(200, {
    "cache-control": revalidate ? "no-cache" : "public, max-age=300, must-revalidate",
    "content-length": assetStat.size,
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  if (headOnly) {
    response.end();
    return;
  }
  const stream = createReadStream(assetPath);
  stream.on("error", () => {
    if (!response.writableEnded) response.destroy();
  });
  stream.pipe(response);
}

function listen(server: Server, host: string, port: number): Promise<DashboardServerAddress> {
  if (server.listening) {
    const current = serverAddress(server);
    if (current) return Promise.resolve(current);
  }
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const current = serverAddress(server);
      if (!current) {
        reject(new Error("Dashboard server has no TCP address"));
        return;
      }
      resolveListen(current);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function serverAddress(server: Server): DashboardServerAddress | null {
  const value = server.address();
  if (!value || typeof value === "string") return null;
  const address = value as AddressInfo;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { host: address.address, port: address.port, url: `http://${urlHost}:${address.port}` };
}

function streamHeaders(): Record<string, string> {
  return {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown, headOnly = false): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : body);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTrustedCommandRequest(
  request: IncomingMessage,
  url: URL,
  accessToken?: string,
): void {
  if (!isTrustedApiRequest(request, url, accessToken)) {
    throw new ForbiddenError("Command request is not trusted");
  }
}

function isTrustedApiRequest(
  request: IncomingMessage,
  url: URL,
  accessToken?: string,
): boolean {
  const localPort = request.socket.localPort;
  const localAddress = request.socket.localAddress;
  if (!localPort || !localAddress) return false;
  if (!isLoopbackHost(localAddress)) return validateToken(request, url, accessToken);
  const hostHeader = request.headers.host;
  if (!hostHeader || !isTrustedAuthority(hostHeader, localPort)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin && !isTrustedOrigin(origin, localPort)) return false;
  return true;
}

function validateToken(request: IncomingMessage, url: URL, expected?: string): boolean {
  if (!expected) return false;
  const authorization = request.headers.authorization;
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : url.searchParams.get("token") ?? "";
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isTrustedAuthority(authority: string, localPort: number): boolean {
  try {
    const url = new URL(`http://${authority}`);
    const authorityPort = url.port ? Number(url.port) : 80;
    return isLoopbackHost(url.hostname) && authorityPort === localPort;
  } catch {
    return false;
  }
}

function isTrustedOrigin(origin: string, localPort: number): boolean {
  try {
    const url = new URL(origin);
    const originPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return url.protocol === "http:" && isLoopbackHost(url.hostname) && originPort === localPort;
  } catch {
    return false;
  }
}

function isLoopbackHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("::ffff:127.") ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

class UnsafePathError extends Error {}
class BadRequestError extends Error {}
class ForbiddenError extends Error {}
