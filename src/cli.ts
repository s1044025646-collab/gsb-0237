#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
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
import { negotiate, parseAcceptHeader } from "./negotiation.js";
import { validateRepresentations, validateResourceId } from "./validation.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index]!;
    if (item.startsWith("--")) {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) flags[item.slice(2)] = true;
      else {
        flags[item.slice(2)] = next;
        index += 1;
      }
    } else {
      positional.push(item);
    }
  }
  return { command, positional, flags };
}

function readRepresentations(file?: string, inline?: string) {
  const text = file
    ? readFileSync(file, "utf8")
    : inline ??
      JSON.stringify([
        { id: "json", mediaType: "application/json", priority: 10, body: '{"format":"json"}' },
        { id: "text", mediaType: "text/plain; charset=utf-8", priority: 20, body: "纯文本 UTF-8" },
        { id: "latin", mediaType: "text/plain; charset=iso-8859-1", priority: 30, body: "latin text" },
      ]);
  return validateRepresentations(JSON.parse(text) as unknown);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function databasePath(flags: Record<string, string | boolean>): string {
  const dataDir = typeof flags["data-dir"] === "string" ? flags["data-dir"] : join(process.cwd(), "data");
  return join(dataDir, "accept-lab.sqlite");
}

function compareVersions(
  database: ReturnType<typeof openDatabase>,
  resourceId: string,
  leftNumber: number,
  rightNumber: number,
): void {
  const left = getVersion(database, resourceId, leftNumber);
  const right = getVersion(database, resourceId, rightNumber);
  if (!left || !right) throw new Error("指定的配置版本不存在");
  const key = (id: string, mediaType: string) => `${id}\u0000${mediaType}`;
  const leftMap = new Map(left.representations.map((item) => [key(item.id, item.mediaType), item]));
  const rightMap = new Map(right.representations.map((item) => [key(item.id, item.mediaType), item]));
  printJson({
    resourceId,
    from: leftNumber,
    to: rightNumber,
    added: right.representations.filter((item) => !leftMap.has(key(item.id, item.mediaType))),
    removed: left.representations.filter((item) => !rightMap.has(key(item.id, item.mediaType))),
    changed: right.representations.flatMap((item) => {
      const previous = leftMap.get(key(item.id, item.mediaType));
      if (!previous || (previous.priority === item.priority && previous.body === item.body)) return [];
      return [{ from: previous, to: item }];
    }),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const database = openDatabase(databasePath(args.flags));

  switch (args.command) {
    case "init": {
      const id = validateResourceId(args.positional[0] ?? "demo");
      const path = normalizePath(typeof args.flags.path === "string" ? args.flags.path : "/demo");
      const representations = readRepresentations(flag(args, "file"), flag(args, "representations"));
      printJson(createResource(database, id, path, representations));
      break;
    }
    case "list":
      printJson({ resources: listResources(database) });
      break;
    case "show": {
      const resource = getResource(database, args.positional[0] ?? "demo");
      if (!resource) throw new Error("资源不存在");
      printJson(resource);
      break;
    }
    case "parse": {
      const header = typeof args.flags.header === "string" ? args.flags.header : "";
      printJson(parseAcceptHeader(header));
      break;
    }
    case "negotiate": {
      const id = validateResourceId(args.positional[0] ?? "demo");
      const resource = getResource(database, id);
      if (!resource) throw new Error("资源不存在");
      const accept = flag(args, "header");
      const report = negotiate(resource.representations, accept);
      const reportId = saveReport(database, id, resource.currentVersion, report);
      printJson({ reportId, configVersion: resource.currentVersion, report });
      break;
    }
    case "versions":
      printJson({ versions: listVersions(database, args.positional[0] ?? "demo") });
      break;
    case "diff": {
      compareVersions(
        database,
        args.positional[0] ?? "demo",
        Number(args.positional[1] ?? 1),
        Number(args.positional[2] ?? 2),
      );
      break;
    }
    case "history":
      printJson({
        history: listReports(database, {
          ...(typeof args.positional[0] === "string" ? { resourceId: args.positional[0] } : {}),
          limit: Number(flag(args, "limit") ?? 20),
        }),
      });
      break;
    default:
      console.log(`用法:
  accept-lab init [resourceId] [--path /demo] [--file representations.json]
  accept-lab list
  accept-lab show <resourceId>
  accept-lab parse --header "application/json, */*;q=0.5"
  accept-lab negotiate <resourceId> --header "text/plain;q=0"
  accept-lab versions <resourceId>
  accept-lab diff <resourceId> <fromVersion> <toVersion>
  accept-lab history [resourceId] --limit 20

选项:
  --data-dir <dir>   SQLite 数据目录，默认 ./data`);
  }
}

main().catch((error: Error) => {
  console.error(JSON.stringify({ error: { message: error.message } }, null, 2));
  process.exitCode = 1;
});
