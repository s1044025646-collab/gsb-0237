// SQLite 存储：资源、表示、配置版本快照、协商报告（报告只增不改）。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { NegotiationResult } from "./negotiate.js";

export interface ResourceRow {
  id: number;
  name: string;
  created_at: string;
}

export interface RepresentationRow {
  id: number;
  resource_id: number;
  media_type: string;
  params_json: string;
  priority: number;
  body: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "negotiation.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS representations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        media_type TEXT NOT NULL,
        params_json TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL,
        body TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS config_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_id INTEGER NOT NULL,
        version_id INTEGER NOT NULL,
        accept_header TEXT,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const v = this.db
      .prepare("SELECT COUNT(*) AS n FROM config_versions")
      .get() as { n: number };
    if (v.n === 0) this.commitVersion("初始版本");
  }

  private now(): string {
    return new Date().toISOString();
  }

  private snapshot(): string {
    const resources = this.db
      .prepare("SELECT * FROM resources ORDER BY id")
      .all();
    const reps = this.db
      .prepare("SELECT * FROM representations ORDER BY id")
      .all();
    return JSON.stringify({ resources, representations: reps }, null, 2);
  }

  commitVersion(note: string): number {
    const r = this.db
      .prepare(
        "INSERT INTO config_versions (note, snapshot_json, created_at) VALUES (?, ?, ?)"
      )
      .run(note, this.snapshot(), this.now());
    return Number(r.lastInsertRowid);
  }

  currentVersion(): number {
    const r = this.db
      .prepare("SELECT MAX(id) AS v FROM config_versions")
      .get() as { v: number };
    return r.v;
  }

  listVersions(): unknown[] {
    return this.db
      .prepare(
        "SELECT id, note, created_at FROM config_versions ORDER BY id"
      )
      .all();
  }

  getVersionSnapshot(id: number): string | null {
    const r = this.db
      .prepare("SELECT snapshot_json FROM config_versions WHERE id = ?")
      .get(id) as { snapshot_json: string } | undefined;
    return r ? r.snapshot_json : null;
  }

  addResource(name: string): number {
    const r = this.db
      .prepare("INSERT INTO resources (name, created_at) VALUES (?, ?)")
      .run(name, this.now());
    const id = Number(r.lastInsertRowid);
    this.commitVersion(`新增资源 ${name}`);
    return id;
  }

  listResources(): ResourceRow[] {
    return this.db
      .prepare("SELECT * FROM resources ORDER BY id")
      .all() as unknown as ResourceRow[];
  }

  getResource(id: number): ResourceRow | null {
    const r = this.db
      .prepare("SELECT * FROM resources WHERE id = ?")
      .get(id) as unknown as ResourceRow | undefined;
    return r ?? null;
  }

  addRepresentation(
    resourceId: number,
    mediaType: string,
    params: Record<string, string>,
    priority: number,
    body: string
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO representations (resource_id, media_type, params_json, priority, body)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(resourceId, mediaType, JSON.stringify(params), priority, body);
    const id = Number(r.lastInsertRowid);
    this.commitVersion(`资源 ${resourceId} 新增表示 ${mediaType}`);
    return id;
  }

  deleteRepresentation(id: number): boolean {
    const r = this.db
      .prepare("DELETE FROM representations WHERE id = ?")
      .run(id);
    if (Number(r.changes) > 0) {
      this.commitVersion(`删除表示 ${id}`);
      return true;
    }
    return false;
  }

  listRepresentations(resourceId: number): RepresentationRow[] {
    return this.db
      .prepare(
        "SELECT * FROM representations WHERE resource_id = ? ORDER BY priority, id"
      )
      .all(resourceId) as unknown as RepresentationRow[];
  }

  saveReport(
    resourceId: number,
    acceptHeader: string | null,
    result: NegotiationResult
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO reports (resource_id, version_id, accept_header, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        resourceId,
        this.currentVersion(),
        acceptHeader,
        JSON.stringify(result),
        this.now()
      );
    return Number(r.lastInsertRowid);
  }

  listReports(resourceId?: number): unknown[] {
    if (resourceId !== undefined) {
      return this.db
        .prepare(
          `SELECT id, resource_id, version_id, accept_header, created_at
           FROM reports WHERE resource_id = ? ORDER BY id`
        )
        .all(resourceId);
    }
    return this.db
      .prepare(
        `SELECT id, resource_id, version_id, accept_header, created_at
         FROM reports ORDER BY id`
      )
      .all();
  }

  getReport(id: number): unknown | null {
    return (
      this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) ?? null
    );
  }

  close(): void {
    this.db.close();
  }
}
