#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  addConfigVersion,
  createResource,
  getResource,
  getVersion,
  listReports,
  listResources,
  listVersions,
  normalizePath,
  openDatabase,
  saveReport,
} from "./db.js";
import { negotiate } from "./negotiation.js";
import {
  assertString,
  validateRepresentations,
  validateResourceId,
} from "./validation.js";

export interface AppOptions {
  dataDir?: string;
  port?: number;
  host?: string;
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法获取空闲端口"));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

export async function createApp(options: AppOptions = {}): Promise<{ server: Server; port: number }> {
  const dataDir = options.dataDir ?? join(process.cwd(), "data");
  const database = openDatabase(join(dataDir, "accept-lab.sqlite"));
  const server = createServer((request, response) => {
    handleRequest(database, request, response).catch((error: Error & { code?: string }) => {
      sendJson(response, error.code === "VALIDATION_ERROR" ? 400 : 500, {
        error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
      });
    });
  });
  server.on("close", () => database.close());
  const port = options.port ?? (await findFreePort(options.host));
  await new Promise<void>((resolve) =>
    server.listen(port, options.host ?? "127.0.0.1", resolve),
  );
  return { server, port: (server.address() as { port: number }).port };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { code: "INVALID_JSON" });
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function handleRequest(
  database: ReturnType<typeof openDatabase>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && url.pathname === "/api/resources") {
    sendJson(response, 200, { resources: listResources(database) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/resources") {
    const body = (await readJson(request)) as Record<string, unknown>;
    const id = validateResourceId(body.id);
    const path = normalizePath(assertString(body.path, "path"));
    const representations = validateRepresentations(body.representations);
    const version = createResource(database, id, path, representations);
    sendJson(response, 201, { resourceId: id, path, version: 1, versionId: version.id });
    return;
  }

  const resourceMatch = url.pathname.match(/^\/api\/resources\/([^/]+)(?:\/versions(?:\/(\d+))?)?$/);
  if (resourceMatch && method === "GET") {
    const resourceId = decodeURIComponent(resourceMatch[1]!);
    if (resourceMatch[2]) {
      const version = getVersion(database, resourceId, Number(resourceMatch[2]));
      if (!version) {
        sendJson(response, 404, { error: { code: "VERSION_NOT_FOUND", message: "版本不存在" } });
        return;
      }
      sendJson(response, 200, version);
      return;
    }
    if (url.pathname.endsWith("/versions")) {
      sendJson(response, 200, { versions: listVersions(database, resourceId) });
      return;
    }
    const resource = getResource(database, resourceId);
    if (!resource) {
      sendJson(response, 404, { error: { code: "RESOURCE_NOT_FOUND", message: "资源不存在" } });
      return;
    }
    sendJson(response, 200, resource);
    return;
  }

  if (resourceMatch && method === "PUT") {
    const resourceId = decodeURIComponent(resourceMatch[1]!);
    if (!getResource(database, resourceId)) {
      sendJson(response, 404, { error: { code: "RESOURCE_NOT_FOUND", message: "资源不存在" } });
      return;
    }
    const body = (await readJson(request)) as Record<string, unknown>;
    const representations = validateRepresentations(body.representations);
    const note = typeof body.note === "string" ? body.note : "configuration update";
    const version = addConfigVersion(database, resourceId, representations, note);
    const current = getResource(database, resourceId)!;
    sendJson(response, 200, {
      resourceId,
      version: current.currentVersion,
      versionId: version.id,
    });
    return;
  }

  if (method === "POST" && url.pathname === "/api/negotiate") {
    const body = (await readJson(request)) as Record<string, unknown>;
    const resourceId = validateResourceId(body.resourceId);
    const resource = getResource(database, resourceId);
    if (!resource) {
      sendJson(response, 404, { error: { code: "RESOURCE_NOT_FOUND", message: "资源不存在" } });
      return;
    }
    const accept = Object.prototype.hasOwnProperty.call(body, "accept")
      ? (body.accept as string | null)
      : undefined;
    const report = negotiate(resource.representations, accept);
    const reportId = saveReport(database, resourceId, resource.currentVersion, report);
    sendJson(response, 200, { reportId, configVersion: resource.currentVersion, report });
    return;
  }

  if (method === "GET" && url.pathname === "/api/history") {
    sendJson(response, 200, { history: listReports(database, { limit: Number(url.searchParams.get("limit") ?? 50) }) });
    return;
  }

  const resource = findResourceByPath(database, url.pathname);
  if (resource && method === "GET") {
    const acceptHeader = request.headers.accept;
    const report = negotiate(resource.representations, acceptHeader);
    const reportId = saveReport(database, resource.id, resource.currentVersion, report);
    response.setHeader("Vary", "Accept");
    response.setHeader("X-Negotiation-Report", String(reportId));
    if (!report.ok || !report.selectedContentType || report.selectedBody === null) {
      sendJson(response, 406, { reportId, report });
      return;
    }
    response.writeHead(200, {
      "Content-Type": report.selectedContentType,
      "Content-Length": Buffer.byteLength(report.selectedBody),
    });
    response.end(report.selectedBody);
    return;
  }

  sendJson(response, 404, { error: { code: "ROUTE_NOT_FOUND", message: "接口不存在" } });
}

function findResourceByPath(database: ReturnType<typeof openDatabase>, pathname: string) {
  for (const item of listResources(database)) {
    if (item.path === pathname) return getResource(database, item.id);
  }
  return null;
}

function parseArgs(argv: string[]): AppOptions {
  const options: AppOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    if (arg === "--host") {
      const host = argv[++index];
      if (host) options.host = host;
    }
    if (arg === "--data-dir") {
      const dataDir = argv[++index];
      if (dataDir) options.dataDir = dataDir;
    }
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("--port 必须是 1 到 65535 的整数");
  }
  return options;
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replaceAll("\\", "/")}`).href) {
  createApp(parseArgs(process.argv.slice(2)))
    .then(({ port, server }) => {
      console.log(`Accept Lab: http://127.0.0.1:${port}`);
      console.log("按 Ctrl+C 停止");
      server.on("close", () => process.exit(0));
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
