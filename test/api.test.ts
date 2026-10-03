import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db.js";
import { startServer } from "../src/server.js";
import { seedDemo } from "../src/seed.js";
import type http from "node:http";

let server: http.Server;
let base: string;
let store: Store;
let demoId: number;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "neg-test-"));
  store = new Store(dataDir);
  demoId = seedDemo(store);
  const started = await startServer(store, 0);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("示例接口：无 Accept 返回 JSON 且带 Vary: Accept", async () => {
  const res = await fetch(`${base}/resources/${demoId}/content`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("vary"), "Accept");
  assert.match(res.headers.get("content-type")!, /^application\/json/);
});

test("示例接口：text/plain 优先时返回纯文本", async () => {
  const res = await fetch(`${base}/resources/${demoId}/content`, {
    headers: { Accept: "text/plain;q=0.9, application/json;q=0.4" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/plain/);
});

test("示例接口：带 charset 参数范围选中带参数表示", async () => {
  const res = await fetch(`${base}/resources/${demoId}/content`, {
    headers: { Accept: "text/plain;charset=utf-8" },
  });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-type")!,
    /text\/plain; charset=utf-8/
  );
});

test("示例接口：全部不接受返回 406 与错误码", async () => {
  const res = await fetch(`${base}/resources/${demoId}/content`, {
    headers: { Accept: "image/png" },
  });
  assert.equal(res.status, 406);
  assert.equal(res.headers.get("vary"), "Accept");
  const body = await res.json();
  assert.equal(body.error.code, "NO_ACCEPTABLE");
});

test("协商接口：非法 q 返回 INVALID_ACCEPT，与 406 区分", async () => {
  const res = await fetch(`${base}/resources/${demoId}/negotiate`, {
    headers: { Accept: "text/html;q=1.2345" },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "INVALID_ACCEPT");
});

test("协商接口：accept-ext 返回 UNSUPPORTED_SYNTAX", async () => {
  const res = await fetch(`${base}/resources/${demoId}/negotiate`, {
    headers: { Accept: "text/html;q=0.5;level=1" },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "UNSUPPORTED_SYNTAX");
});

test("协商接口：报告含每个候选的匹配范围与淘汰原因", async () => {
  const res = await fetch(`${base}/resources/${demoId}/negotiate`, {
    headers: { Accept: "application/json;q=0, */*;q=0.5" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const json = body.report.candidates.find(
    (c: { representationId: number }) =>
      c.representationId ===
      store.listRepresentations(demoId).find((r) => r.media_type === "application/json")!.id
  );
  assert.equal(json.q, 0);
  assert.equal(json.accepted, false);
  assert.match(json.reason, /q=0/);
});

test("历史：报告被保存且配置变更后旧报告不变", async () => {
  const before1 = (await (await fetch(`${base}/reports`)).json()).reports
    .length;
  await fetch(`${base}/resources/${demoId}/negotiate`, {
    headers: { Accept: "*/*" },
  });
  const reports = (await (await fetch(`${base}/reports`)).json()).reports;
  assert.ok(reports.length > before1);
  const last = reports[reports.length - 1];
  const detail = await (
    await fetch(`${base}/reports/${last.id}`)
  ).json();
  const snapshotBefore = detail.result_json;
  // 修改配置（新增表示）不应改写旧报告
  await fetch(`${base}/resources/${demoId}/representations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaType: "text/html",
      priority: 9,
      body: "<p>hi</p>",
    }),
  });
  const detail2 = await (
    await fetch(`${base}/reports/${last.id}`)
  ).json();
  assert.equal(detail2.result_json, snapshotBefore);
});

test("版本：配置版本可比较且随修改增长", async () => {
  const v1 = (await (await fetch(`${base}/config-versions`)).json()).versions;
  assert.ok(v1.length >= 2);
  const diff = await (
    await fetch(`${base}/config-versions/diff?from=1&to=${v1.length}`)
  ).json();
  assert.ok(Array.isArray(diff.from.resources));
  assert.ok(Array.isArray(diff.to.representations));
});

test("校验：非法 mediaType 返回 VALIDATION", async () => {
  const res = await fetch(`${base}/resources/${demoId}/representations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mediaType: "not-a-type", priority: 1 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, "VALIDATION");
});

test("解析接口：带引号逗号参数不被切开", async () => {
  const res = await fetch(`${base}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ header: 'text/plain;note="a,b", application/json' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ranges.length, 2);
  assert.equal(body.ranges[0].params.note, "a,b");
});
