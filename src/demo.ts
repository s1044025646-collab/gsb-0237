import { join } from "node:path";
import { rmSync } from "node:fs";
import { createApp } from "./server.js";

const dataDir = join(process.cwd(), "data", "demo");
rmSync(dataDir, { recursive: true, force: true });
const app = await createApp({ dataDir });
const baseUrl = `http://127.0.0.1:${app.port}`;

await fetch(`${baseUrl}/api/resources`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: "demo",
    path: "/demo",
    representations: [
      { id: "json", mediaType: "application/json", priority: 10, body: '{"message":"JSON 表示"}' },
      { id: "utf8", mediaType: "text/plain; charset=utf-8", priority: 20, body: "UTF-8 纯文本" },
      { id: "latin", mediaType: "text/plain; charset=iso-8859-1", priority: 30, body: "Latin text" },
    ],
  }),
});

const cases = [
  ["通配符", "*/*"],
  ["具体优先", "*/*;q=1, text/*;q=0.1, text/plain;charset=utf-8;q=0.5"],
  ["具体排除", "application/json;q=0, */*;q=1"],
  ["全部不接受", "*/*;q=0"],
];

for (const [name, accept] of cases) {
  const response = await fetch(`${baseUrl}/demo`, { headers: { Accept: accept! } });
  console.log(`\n${name}: ${accept}`);
  console.log(`HTTP ${response.status}; Content-Type: ${response.headers.get("Content-Type")}; Vary: ${response.headers.get("Vary")}`);
  console.log(await response.text());
}

console.log(`\n解释接口: ${baseUrl}/api/negotiate`);
console.log("演示数据保留在 data/demo/accept-lab.sqlite，服务器将在 3 秒后关闭");
setTimeout(() => app.server.close(), 3000);
