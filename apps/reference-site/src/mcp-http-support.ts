import type {
  McpCursorBinding,
  McpCursorCodec,
} from "@foundry/application";
import type { SiteId } from "@foundry/site-definition";

const cursorLifetimeSeconds = 15 * 60;

export type JsonRecord = Record<string, unknown>;

export type RpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}>;

export function isRequestId(value: unknown): value is string | number {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: JsonRecord,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export class RequestBodyLimitError extends Error {}

export class RequestDeadlineExceededError extends Error {
  constructor() {
    super("mcp_request_timeout");
    this.name = "RequestDeadlineExceededError";
  }
}

export type RequestExecutionContext = Readonly<{
  signal: AbortSignal;
  throwIfExpired(): void;
  waitFor<Result>(operation: Promise<Result>): Promise<Result>;
}>;

export function createRequestExecutionContext(milliseconds: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  const throwIfExpired = () => {
    if (controller.signal.aborted) {
      throw new RequestDeadlineExceededError();
    }
  };
  const context: RequestExecutionContext = {
    signal: controller.signal,
    throwIfExpired,
    waitFor<Result>(operation: Promise<Result>) {
      throwIfExpired();
      return new Promise<Result>((resolve, reject) => {
        const expired = () => {
          cleanup();
          reject(new RequestDeadlineExceededError());
        };
        const cleanup = () => {
          controller.signal.removeEventListener("abort", expired);
        };
        controller.signal.addEventListener("abort", expired, { once: true });
        operation.then(
          (result) => {
            cleanup();
            try {
              throwIfExpired();
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
      });
    },
  };
  return {
    context,
    dispose() {
      clearTimeout(timeout);
    },
  };
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number,
  signal?: AbortSignal,
) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RequestBodyLimitError();
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const cancelReader = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted === true) {
        await reader.cancel();
        throw new RequestDeadlineExceededError();
      }
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RequestBodyLimitError();
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export function valueDepth(
  value: unknown,
  maximumDepth: number,
): number {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let deepest = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    deepest = Math.max(deepest, current.depth);
    if (deepest > maximumDepth) return deepest;
    const children = Array.isArray(current.value)
      ? current.value
      : isRecord(current.value)
        ? Object.values(current.value)
        : [];
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return deepest;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function hmacKey(secret: string) {
  if (secret.length < 32) {
    throw new TypeError("mcp_signing_secret_invalid");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function createSignedMcpCursorCodec({
  secret,
  now = () => new Date(),
}: {
  secret: string;
  now?: () => Date;
}): McpCursorCodec {
  return {
    async encode(binding) {
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            ...binding,
            expiresAt:
              Math.floor(now().getTime() / 1_000) + cursorLifetimeSeconds,
          }),
        ),
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret),
        new TextEncoder().encode(payload),
      );
      return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    async decode(cursor) {
      const [payload, signature, unexpected] = cursor.split(".");
      if (
        payload === undefined ||
        signature === undefined ||
        unexpected !== undefined
      ) {
        throw new TypeError("mcp_cursor_invalid");
      }
      const verified = await crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret),
        base64UrlDecode(signature).buffer as ArrayBuffer,
        new TextEncoder().encode(payload),
      );
      const decoded: unknown = JSON.parse(
        new TextDecoder().decode(base64UrlDecode(payload)),
      );
      if (
        !verified ||
        !isRecord(decoded) ||
        typeof decoded.siteId !== "string" ||
        typeof decoded.actorId !== "string" ||
        typeof decoded.query !== "string" ||
        typeof decoded.offset !== "number" ||
        typeof decoded.expiresAt !== "number" ||
        decoded.expiresAt < Math.floor(now().getTime() / 1_000)
      ) {
        throw new TypeError("mcp_cursor_invalid");
      }
      return {
        siteId: decoded.siteId as SiteId,
        actorId: decoded.actorId,
        query: decoded.query,
        offset: decoded.offset,
      } satisfies McpCursorBinding;
    },
  };
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function rpcResult(id: RpcRequest["id"], result: unknown) {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

export function rpcError(
  id: RpcRequest["id"] | null,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    },
    status,
    headers,
  );
}
