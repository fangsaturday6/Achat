import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { RelayError } from "./service.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// An idle connection stays open 125 seconds for the next request, not Node's
// 5: whoever reuses one must give it up first, or a request goes out on a
// connection the server is just closing ("fetch failed", or a 502 from the
// proxy). fetch gives one up shortly before the time the server names; Caddy
// in front of the cloud keeps an idle one for 2 minutes. The time to read a
// request's headers stays Node's: it only runs while a request comes in.
export function keepConnections(server: Server): void {
  server.keepAliveTimeout = 125_000;
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

// A body can be read once; the cloud reads it to check the signature before
// the route handler parses it, so it is kept here.
const bodies = new WeakMap<IncomingMessage, Buffer>();

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const read = bodies.get(req);
  if (read) return read;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RelayError(413, "请求太大");
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  bodies.set(req, body);
  return body;
}

export function parseJson(raw: Buffer): Record<string, unknown> {
  if (!raw.length) return {};
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new RelayError(400, "请求内容不是合法的 JSON 对象");
  }
}

export async function readJson(req: IncomingMessage, limit?: number): Promise<Record<string, unknown>> {
  return parseJson(await readBody(req, limit));
}

export function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new RelayError(400, `缺少字段：${key}`);
  return value;
}

export function optNum(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RelayError(400, `字段 ${key} 需要是数字`);
  return value;
}

// Serves a file from the web directory. `transform` can rewrite index.html,
// for example to fill in the local token.
export async function serveStatic(
  res: ServerResponse,
  webDir: string,
  pathname: string,
  transform?: (html: string) => string,
): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(webDir, rel));
  if (!file.startsWith(normalize(webDir))) return send(res, 404, { error: "not found" });
  try {
    let content: Buffer | string = await readFile(file);
    if (rel === "index.html" && transform) content = transform(content.toString("utf8"));
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
    });
    res.end(content);
  } catch {
    send(res, 404, { error: "not found" });
  }
}
