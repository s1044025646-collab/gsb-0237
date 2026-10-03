// CLI 入口：node dist/src/cli.js <command> ...
import path from "node:path";
import { Store } from "./db.js";
import { negotiate, Representation } from "./negotiate.js";
import { parseAccept } from "./accept.js";
import { startServer } from "./server.js";
import { seedDemo } from "./seed.js";

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | true>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function toReps(store: Store, resourceId: number): Representation[] {
  return store.listRepresentations(resourceId).map((r) => ({
    id: r.id,
    mediaType: r.media_type,
    params: JSON.parse(r.params_json),
    priority: r.priority,
    body: r.body,
  }));
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

const USAGE = `用法: node dist/src/cli.js <命令>
  serve [--port N]                     启动 HTTP 服务（默认 0 = 自动选空闲端口）
  seed                                 写入演示资源 demo
  resource add <name>                  新增资源
  resource list                        列出资源
  rep add <resourceId> --type T --priority N [--param k=v]... [--body S]
  rep list <resourceId>                列出表示
  rep del <repId>                      删除表示
  parse "<Accept 头>"                  仅解析请求头
  negotiate <resourceId> [--header H]  执行协商并保存报告（缺省 = 未提供 Accept）
  report list [resourceId]             列出历史报告
  report show <reportId>               查看报告详情
  version list                         列出配置版本
  version diff <from> <to>             比较两个版本快照
  demo                                 运行四种演示场景（通配/排除/不同 q/全不接受）
数据目录: 环境变量 DATA_DIR，默认 ./data`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.log(USAGE);
    return;
  }
  const store = new Store(dataDir);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "serve": {
      seedDemo(store);
      const port = flags.port !== undefined ? Number(flags.port) : 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("--port 须为 0~65535 的整数");
      const { port: actual } = await startServer(store, port);
      console.log(`服务已启动: http://127.0.0.1:${actual}（演示资源 id 见 seed）`);
      break;
    }
    case "seed": {
      const id = seedDemo(store);
      console.log(`演示资源 demo id=${id}`);
      break;
    }
    case "resource": {
      if (positional[0] === "add") {
        print({ id: store.addResource(positional[1]) });
      } else if (positional[0] === "list") {
        print(store.listResources());
      } else throw new Error("未知 resource 子命令");
      break;
    }
    case "rep": {
      if (positional[0] === "add") {
        const resourceId = Number(positional[1]);
        const params: Record<string, string> = {};
        const raw = flags.param;
        for (const p of Array.isArray(raw) ? raw : raw ? [raw] : []) {
          const eq = String(p).indexOf("=");
          params[String(p).slice(0, eq).toLowerCase()] = String(p).slice(eq + 1);
        }
        // parseFlags 不支持重复键，改用扫描原始参数
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--param" && rest[i + 1]) {
            const eq = rest[i + 1].indexOf("=");
            params[rest[i + 1].slice(0, eq).toLowerCase()] =
              rest[i + 1].slice(eq + 1);
          }
        }
        print({
          id: store.addRepresentation(
            resourceId,
            String(flags.type),
            params,
            Number(flags.priority),
            typeof flags.body === "string" ? flags.body : ""
          ),
        });
      } else if (positional[0] === "list") {
        print(store.listRepresentations(Number(positional[1])));
      } else if (positional[0] === "del") {
        print({ deleted: store.deleteRepresentation(Number(positional[1])) });
      } else throw new Error("未知 rep 子命令");
      break;
    }
    case "parse": {
      print(parseAccept(positional[0] ?? ""));
      break;
    }
    case "negotiate": {
      const resourceId = Number(positional[0]);
      const header =
        flags.header !== undefined
          ? flags.header === true
            ? ""
            : String(flags.header)
          : null;
      const result = negotiate(header, toReps(store, resourceId));
      const reportId = store.saveReport(resourceId, header, result);
      print({ reportId, ...result });
      if (result.status === "not_acceptable") process.exitCode = 2;
      break;
    }
    case "report": {
      if (positional[0] === "list") {
        print(
          store.listReports(
            positional[1] !== undefined ? Number(positional[1]) : undefined
          )
        );
      } else if (positional[0] === "show") {
        print(store.getReport(Number(positional[1])));
      } else throw new Error("未知 report 子命令");
      break;
    }
    case "version": {
      if (positional[0] === "list") {
        print(store.listVersions());
      } else if (positional[0] === "diff") {
        print({
          from: JSON.parse(
            store.getVersionSnapshot(Number(positional[1])) ?? "null"
          ),
          to: JSON.parse(
            store.getVersionSnapshot(Number(positional[2])) ?? "null"
          ),
        });
      } else throw new Error("未知 version 子命令");
      break;
    }
    case "demo": {
      const id = seedDemo(store);
      const reps = toReps(store, id);
      const scenarios: Array<[string, string | null]> = [
        ["通配符 */*", "*/*"],
        ["具体排除 application/json（q=0 不能被 */* 救回）", "application/json;q=0, */*;q=0.5"],
        ["不同 q 值", "text/plain;q=0.9, application/json;q=0.4"],
        ["全部不接受", "image/png"],
      ];
      for (const [title, header] of scenarios) {
        const result = negotiate(header, reps);
        const reportId = store.saveReport(id, header, result);
        console.log(`\n=== ${title} ===`);
        console.log(`Accept: ${header ?? "(未提供)"}  报告 #${reportId}`);
        if (result.selected) {
          const params = Object.entries(result.selected.params)
            .map(([k, v]) => `; ${k}=${v}`)
            .join("");
          console.log(
            `选中: ${result.selected.mediaType}${params} (表示 #${result.selected.representationId}, q=${result.selected.q})`
          );
        } else {
          console.log("结果: 406 没有可接受的表示");
        }
        for (const c of result.candidates) {
          console.log(
            `  - 表示#${c.representationId} ${c.mediaType} 匹配范围=${c.matchedRange ?? "无"} q=${c.q ?? "-"} → ${c.reason}`
          );
        }
      }
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
  if (cmd !== "serve") store.close();
}

main().catch((err) => {
  console.error(`错误: ${err.message}`);
  process.exitCode = 1;
});
