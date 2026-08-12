import { setTimeout as delay } from "node:timers/promises";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  async sleep(ms, signal) {
    await delay(ms, undefined, signal ? { signal } : undefined);
  },
};

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced) as T;
    const start = Math.min(
      ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((n) => n >= 0),
    );
    if (Number.isFinite(start)) {
      const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
      if (end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error("Agent response was not valid JSON");
  }
}

export function truncate(text: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative integer");
  }
  if (maxChars === 0) return "";
  if (text.length <= maxChars) return text;

  let marker = "\n…[content omitted from middle; head and tail preserved]…\n";
  if (marker.length >= maxChars) return safePrefix(text, maxChars);
  for (let pass = 0; pass < 3; pass += 1) {
    const retained = maxChars - marker.length;
    const headChars = Math.ceil(retained * 0.6);
    const tailChars = retained - headChars;
    const omitted = Math.max(0, text.length - headChars - tailChars);
    marker = `\n…[${omitted} chars omitted from middle; head and tail preserved]…\n`;
  }
  const retained = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(retained * 0.6);
  const tailChars = retained - headChars;
  const head = safePrefix(text, headChars);
  const tail = safeSuffix(text, tailChars);
  const packed = `${head}${marker}${tail}`;
  return packed.length <= maxChars ? packed : safePrefix(packed, maxChars);
}

function safePrefix(text: string, maxChars: number): string {
  let end = Math.min(text.length, Math.max(0, maxChars));
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function safeSuffix(text: string, maxChars: number): string {
  let start = Math.max(0, text.length - Math.max(0, maxChars));
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start += 1;
  return text.slice(start);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function sameStringSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = uniqueSorted(a);
  const right = uniqueSorted(b);
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function combineSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

export function isoNow(): string {
  return new Date().toISOString();
}
