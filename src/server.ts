// HTTP API：仅使用 Node 内置 http 模块。
import http from "node:http";
import { Store } from "./db.js";
import { negotiate, Representation } from "./negotiate.js";
import {
  parseAccept,
  AcceptSyntaxError,
  UnsupportedSyntaxError,
} from "./accept.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function toReps(rows: ReturnType<Store["listRepresentations"]>): Representation[] {
  return rows.map((r) => ({
    id: r.id,
    mediaType: r.media_type,
    params: JSON.parse(r.params_json),
    priority: r.priority,
    body: r.body,
  }));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是合法 JSON 对象");
  }
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "")
    throw new ApiError(400, "VALIDATION", `字段 ${name} 必须为非空字符串`);
  return v;
}

function requireInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v))
    throw new ApiError(400, "VALIDATION", `字段 ${name} 必须为整数`);
  return v;
}

const MEDIA_TYPE_RE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function createServer(store: Store): http.Server {
  const handler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      const body = JSON.stringify(obj, null, 2);
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      });
      res.end(body);
    };

    try {
      // POST /resources {name}
      if (method === "POST" && path === "/resources") {
        const body = parseJsonBody(await readBody(req));
        const name = requireString(body.name, "name");
        const id = store.addResource(name);
        return send(201, { id, name });
      }
      // GET /resources
      if (method === "GET" && path === "/resources") {
        return send(200, { resources: store.listResources() });
      }

      const mRes = path.match(/^\/resources\/(\d+)(\/.*)?$/);
      if (mRes) {
        const resourceId = Number(mRes[1]);
        const sub = mRes[2] ?? "";
        const resource = store.getResource(resourceId);
        if (!resource)
          throw new ApiError(404, "NOT_FOUND", `资源 ${resourceId} 不存在`);

        // POST /resources/:id/representations
        if (method === "POST" && sub === "/representations") {
          const body = parseJsonBody(await readBody(req));
          const mediaType = requireString(body.mediaType, "mediaType");
          if (!MEDIA_TYPE_RE.test(mediaType))
            throw new ApiError(400, "VALIDATION", "mediaType 须为 type/subtype");
          const priority = requireInt(body.priority, "priority");
          const params = (body.params ?? {}) as Record<string, unknown>;
          if (typeof params !== "object" || params === null || Array.isArray(params))
            throw new ApiError(400, "VALIDATION", "params 须为对象");
          const cleanParams: Record<string, string> = {};
          for (const [k, v] of Object.entries(params)) {
            if (typeof v !== "string")
              throw new ApiError(400, "VALIDATION", "params 的值须为字符串");
            cleanParams[k.toLowerCase()] = v;
          }
          const repBody = typeof body.body === "string" ? body.body : "";
          const id = store.addRepresentation(
            resourceId,
            mediaType.toLowerCase(),
            cleanParams,
            priority,
            repBody
          );
          return send(201, { id });
        }
        // GET /resources/:id/representations
        if (method === "GET" && sub === "/representations") {
          return send(200, {
            representations: store.listRepresentations(resourceId),
          });
        }
        // GET /resources/:id/negotiate —— 用请求的 Accept 头执行协商并保存报告
        if (method === "GET" && sub === "/negotiate") {
          const header = req.headers.accept ?? null;
          const result = negotiate(header, toReps(store.listRepresentations(resourceId)));
          const reportId = store.saveReport(resourceId, header, result);
          if (result.status === "not_acceptable") {
            return send(406, {
              error: { code: "NO_ACCEPTABLE", message: "没有可接受的表示" },
              reportId,
              report: result,
            });
          }
          return send(200, { reportId, report: result });
        }
        // GET /resources/:id/content —— 示例资源接口，实际返回选中的 Content-Type
        if (method === "GET" && sub === "/content") {
          const header = req.headers.accept ?? null;
          const reps = store.listRepresentations(resourceId);
          const result = negotiate(header, toReps(reps));
          store.saveReport(resourceId, header, result);
          const vary = { Vary: "Accept" };
          if (result.status === "not_acceptable") {
            return send(
              406,
              { error: { code: "NO_ACCEPTABLE", message: "没有可接受的表示" } },
              vary
            );
          }
          const sel = result.selected!;
          const row = reps.find((r) => r.id === sel.representationId)!;
          const params = JSON.parse(row.params_json) as Record<string, string>;
          const paramStr = Object.entries(params)
            .map(([k, v]) => `; ${k}=${v}`)
            .join("");
          res.writeHead(200, {
            "Content-Type": `${row.media_type}${paramStr}`,
            ...vary,
          });
          return res.end(row.body);
        }
      }

      // DELETE /representations/:id
      const mRep = path.match(/^\/representations\/(\d+)$/);
      if (mRep && method === "DELETE") {
        const ok = store.deleteRepresentation(Number(mRep[1]));
        if (!ok) throw new ApiError(404, "NOT_FOUND", "表示不存在");
        return send(200, { deleted: true });
      }

      // POST /parse {header}
      if (method === "POST" && path === "/parse") {
        const body = parseJsonBody(await readBody(req));
        const header = requireString(body.header, "header");
        return send(200, { ranges: parseAccept(header) });
      }

      // GET /reports, GET /reports/:id
      if (method === "GET" && path === "/reports") {
        const rid = url.searchParams.get("resourceId");
        return send(200, {
          reports: store.listReports(rid ? Number(rid) : undefined),
        });
      }
      const mReport = path.match(/^\/reports\/(\d+)$/);
      if (mReport && method === "GET") {
        const r = store.getReport(Number(mReport[1]));
        if (!r) throw new ApiError(404, "NOT_FOUND", "报告不存在");
        return send(200, r);
      }

      // GET /config-versions, GET /config-versions/diff?from=1&to=2
      if (method === "GET" && path === "/config-versions") {
        return send(200, { versions: store.listVersions() });
      }
      if (method === "GET" && path === "/config-versions/diff") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!Number.isInteger(from) || !Number.isInteger(to))
          throw new ApiError(400, "VALIDATION", "from/to 须为整数版本号");
        const a = store.getVersionSnapshot(from);
        const b = store.getVersionSnapshot(to);
        if (a === null || b === null)
          throw new ApiError(404, "NOT_FOUND", "版本不存在");
        return send(200, {
          from: JSON.parse(a),
          to: JSON.parse(b),
        });
      }

      throw new ApiError(404, "NOT_FOUND", `${method} ${path} 不存在`);
    } catch (err) {
      if (err instanceof ApiError) {
        return send(err.status, {
          error: { code: err.code, message: err.message },
        });
      }
      if (
        err instanceof AcceptSyntaxError ||
        err instanceof UnsupportedSyntaxError
      ) {
        return send(400, {
          error: { code: err.code, message: err.message },
        });
      }
      return send(500, {
        error: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };
  return http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

export function startServer(
  store: Store,
  port: number
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}
