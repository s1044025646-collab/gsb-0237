// 演示数据：JSON、纯文本、带 charset 参数的文本三种表示。
import { Store } from "./db.js";

export function seedDemo(store: Store): number {
  const existing = store.listResources().find((r) => r.name === "demo");
  if (existing) return existing.id;
  const id = store.addResource("demo");
  store.addRepresentation(
    id,
    "application/json",
    {},
    1,
    JSON.stringify({ message: "你好，这是 JSON 表示" })
  );
  store.addRepresentation(id, "text/plain", {}, 2, "你好，这是纯文本表示");
  store.addRepresentation(
    id,
    "text/plain",
    { charset: "utf-8" },
    3,
    "你好，这是带 charset=utf-8 的文本表示"
  );
  return id;
}
