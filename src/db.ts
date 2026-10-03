import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NegotiationReport, Representation } from "./types.js";

export interface ResourceRecord {
  id: string;
  path: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigVersion {
  id: number;
  resourceId: string;
  representations: Representation[];
  createdAt: string;
  changeNote: string | null;
}

export function openDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      representations_json TEXT NOT NULL,
      change_note TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(resource_id, version_number),
      FOREIGN KEY(resource_id) REFERENCES resources(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS negotiation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL,
      config_version INTEGER NOT NULL,
      raw_accept_header TEXT,
      accept_present INTEGER NOT NULL,
      status INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return database;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createResource(
  database: DatabaseSync,
  id: string,
  path: string,
  representations: Representation[],
  note = "initial configuration",
): ConfigVersion {
  const timestamp = nowIso();
  database
    .prepare(
      `INSERT INTO resources(id, path, current_version, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    )
    .run(id, normalizePath(path), timestamp, timestamp);
  const result = database
    .prepare(
      `INSERT INTO config_versions(resource_id, version_number, representations_json, change_note, created_at)
       VALUES (?, 1, ?, ?, ?)`,
    )
    .run(id, JSON.stringify(representations), note, timestamp);
  return {
    id: Number(result.lastInsertRowid),
    resourceId: id,
    representations,
    createdAt: timestamp,
    changeNote: note,
  };
}

export function addConfigVersion(
  database: DatabaseSync,
  resourceId: string,
  representations: Representation[],
  note: string,
): ConfigVersion {
  const resource = getResource(database, resourceId);
  if (!resource) throw Object.assign(new Error("资源不存在"), { code: "RESOURCE_NOT_FOUND" });
  const versionNumber = resource.currentVersion + 1;
  const timestamp = nowIso();
  database.exec("BEGIN");
  try {
    database
      .prepare("UPDATE resources SET current_version = ?, updated_at = ? WHERE id = ?")
      .run(versionNumber, timestamp, resourceId);
    const result = database
      .prepare(
        `INSERT INTO config_versions(resource_id, version_number, representations_json, change_note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(resourceId, versionNumber, JSON.stringify(representations), note, timestamp);
    database.exec("COMMIT");
    return {
      id: Number(result.lastInsertRowid),
      resourceId,
      representations,
      createdAt: timestamp,
      changeNote: note,
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function normalizePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/.test(normalized)) {
    throw Object.assign(new Error("资源路径格式非法"), { code: "VALIDATION_ERROR" });
  }
  return normalized;
}

export function getResource(
  database: DatabaseSync,
  idOrPath: string,
): (ResourceRecord & { representations: Representation[] }) | null {
  const resource = database
    .prepare("SELECT * FROM resources WHERE id = ? OR path = ?")
    .get(idOrPath, normalizePathSafe(idOrPath)) as
    | Record<string, string | number>
    | undefined;
  if (!resource) return null;
  const versionRow = database
    .prepare(
      `SELECT representations_json FROM config_versions
       WHERE resource_id = ? AND version_number = ?`,
    )
    .get(String(resource.id), Number(resource.current_version)) as
    | { representations_json: string }
    | undefined;
  return {
    id: String(resource.id),
    path: String(resource.path),
    currentVersion: Number(resource.current_version),
    createdAt: String(resource.created_at),
    updatedAt: String(resource.updated_at),
    representations: JSON.parse(versionRow!.representations_json) as Representation[],
  };
}

function normalizePathSafe(value: string): string {
  if (value.startsWith("/")) return value;
  return `/${value}`;
}

export function listResources(database: DatabaseSync): ResourceRecord[] {
  return (
    database
      .prepare("SELECT * FROM resources ORDER BY id")
      .all() as Array<Record<string, string | number>>
  ).map((row) => ({
    id: String(row.id),
    path: String(row.path),
    currentVersion: Number(row.current_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export function getVersion(
  database: DatabaseSync,
  resourceId: string,
  versionNumber: number,
): (ConfigVersion & { versionNumber: number }) | null {
  const row = database
    .prepare("SELECT * FROM config_versions WHERE resource_id = ? AND version_number = ?")
    .get(resourceId, versionNumber) as
    | {
        id: number;
        resource_id: string;
        version_number: number;
        representations_json: string;
        change_note: string | null;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    versionNumber: row.version_number,
    resourceId: row.resource_id,
    representations: JSON.parse(row.representations_json) as Representation[],
    createdAt: row.created_at,
    changeNote: row.change_note,
  };
}

export function listVersions(
  database: DatabaseSync,
  resourceId: string,
): Array<ConfigVersion & { versionNumber: number }> {
  return (
    database
      .prepare("SELECT * FROM config_versions WHERE resource_id = ? ORDER BY version_number")
      .all(resourceId) as Array<{
      id: number;
      resource_id: string;
      version_number: number;
      representations_json: string;
      change_note: string | null;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    resourceId: row.resource_id,
    representations: JSON.parse(row.representations_json) as Representation[],
    createdAt: row.created_at,
    changeNote: row.change_note,
  }));
}

export function saveReport(
  database: DatabaseSync,
  resourceId: string,
  configVersion: number,
  report: NegotiationReport,
): number {
  const result = database
    .prepare(
      `INSERT INTO negotiation_reports(
        resource_id, config_version, raw_accept_header, accept_present, status, report_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      resourceId,
      configVersion,
      report.rawAcceptHeader,
      report.acceptPresent ? 1 : 0,
      report.status,
      JSON.stringify(report),
      nowIso(),
    );
  return Number(result.lastInsertRowid);
}

export function listReports(
  database: DatabaseSync,
  options: { resourceId?: string; limit?: number } = {},
): unknown[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = options.resourceId
    ? database
        .prepare(
          `SELECT id, resource_id, config_version, raw_accept_header, status, created_at
           FROM negotiation_reports WHERE resource_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(options.resourceId, limit)
    : database
        .prepare(
          `SELECT id, resource_id, config_version, raw_accept_header, status, created_at
           FROM negotiation_reports ORDER BY id DESC LIMIT ?`,
        )
        .all(limit);
  return rows;
}
