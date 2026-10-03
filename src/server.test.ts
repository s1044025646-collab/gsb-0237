import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "./server.js";
import type { Server } from "node:http";

describe("HTTP 示例接口", () => {
  let server: Server;
  let baseUrl: string;
  let dataDir: string;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "accept-lab-"));
    const app = await createApp({ dataDir });
    server = app.server;
    baseUrl = `http://127.0.0.1:${app.port}`;
    const response = await fetch(`${baseUrl}/api/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "demo",
        path: "/demo",
        representations: [
          { id: "json", mediaType: "application/json", priority: 10, body: '{"ok":true}' },
          { id: "text", mediaType: "text/plain; charset=utf-8", priority: 20, body: "hello" },
        ],
      }),
    });
    assert.equal(response.status, 201);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it("返回协商后的 Content-Type 并设置 Vary", async () => {
    const response = await fetch(`${baseUrl}/demo`, { headers: { Accept: "text/plain;charset=utf-8" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("Vary"), "Accept");
    assert.equal(await response.text(), "hello");
  });

  it("406 响应仍设置 Vary", async () => {
    const response = await fetch(`${baseUrl}/demo`, { headers: { Accept: "*/*;q=0" } });
    assert.equal(response.status, 406);
    assert.equal(response.headers.get("Vary"), "Accept");
  });
});
