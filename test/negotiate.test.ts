import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccept, AcceptSyntaxError, UnsupportedSyntaxError } from "../src/accept.js";
import { negotiate, Representation } from "../src/negotiate.js";

const reps: Representation[] = [
  { id: 1, mediaType: "application/json", params: {}, priority: 1, body: "{}" },
  { id: 2, mediaType: "text/plain", params: {}, priority: 2, body: "plain" },
  {
    id: 3,
    mediaType: "text/plain",
    params: { charset: "utf-8" },
    priority: 3,
    body: "utf8",
  },
];

test("解析：逗号列表、通配、q 值", () => {
  const rs = parseAccept("text/html, application/json;q=0.8, */*;q=0.1");
  assert.equal(rs.length, 3);
  assert.equal(rs[0].type, "text");
  assert.equal(rs[1].q, 0.8);
  assert.equal(rs[2].type, "*");
});

test("解析：q 默认值为 1", () => {
  const rs = parseAccept("text/html");
  assert.equal(rs[0].q, 1);
});

test("解析：大小写不敏感（类型与 q 名）", () => {
  const rs = parseAccept("Text/Plain; Q=0.5");
  assert.equal(rs[0].type, "text");
  assert.equal(rs[0].q, 0.5);
});

test("解析：带引号参数值中的逗号不被切开", () => {
  const rs = parseAccept('text/plain;note="a,b", application/json');
  assert.equal(rs.length, 2);
  assert.equal(rs[0].params.note, "a,b");
});

test("解析：非法 q 报错（四位小数 / 超范围 / 非数字）", () => {
  assert.throws(() => parseAccept("a/b;q=0.1234"), AcceptSyntaxError);
  assert.throws(() => parseAccept("a/b;q=1.5"), AcceptSyntaxError);
  assert.throws(() => parseAccept("a/b;q=x"), AcceptSyntaxError);
  assert.throws(() => parseAccept("a/b;q="), AcceptSyntaxError);
});

test("解析：q 合法边界 0、0.001、1、1.000", () => {
  for (const q of ["0", "0.001", "1", "1.000", "0.999"]) {
    assert.doesNotThrow(() => parseAccept(`a/b;q=${q}`));
  }
});

test("解析：q 之后的 accept-ext 属不支持语法", () => {
  assert.throws(() => parseAccept("a/b;q=0.5;ext=1"), UnsupportedSyntaxError);
});

test("解析：星号/非星号 属不支持语法", () => {
  assert.throws(() => parseAccept("*/json"), UnsupportedSyntaxError);
});

test("协商：最具体范围决定 q，具体 q=0 不被星号范围救回", () => {
  const r = negotiate("application/json;q=0, */*;q=1", reps);
  const json = r.candidates.find((c) => c.representationId === 1)!;
  assert.equal(json.matchedRange, "application/json;q=0");
  assert.equal(json.q, 0);
  assert.equal(json.accepted, false);
  assert.equal(r.selected!.representationId, 2);
});

test("协商：type/星号 比 星号/星号 更具体", () => {
  const r = negotiate("text/*;q=0.2, */*;q=0.9", reps);
  const plain = r.candidates.find((c) => c.representationId === 2)!;
  assert.equal(plain.q, 0.2);
  assert.equal(plain.specificity, 1);
  assert.equal(r.selected!.representationId, 1);
});

test("协商：带参数范围只匹配具备该参数的候选", () => {
  const r = negotiate("text/plain;charset=utf-8;q=0.9, text/plain;q=0.1", reps);
  const withCharset = r.candidates.find((c) => c.representationId === 3)!;
  const plain = r.candidates.find((c) => c.representationId === 2)!;
  assert.equal(withCharset.matchedRange, "text/plain;charset=utf-8;q=0.9");
  assert.equal(withCharset.q, 0.9);
  assert.equal(plain.q, 0.1);
  assert.equal(r.selected!.representationId, 3);
});

test("协商：同分时按服务端 priority 稳定决策", () => {
  const r = negotiate("text/plain", reps);
  assert.equal(r.selected!.representationId, 2);
});

test("协商：重复同等具体范围取先出现者", () => {
  const r = negotiate("application/json;q=0.3, application/json;q=0.9", reps);
  const json = r.candidates.find((c) => c.representationId === 1)!;
  assert.equal(json.q, 0.3);
});

test("协商：全部 q=0 不可接受", () => {
  const r = negotiate("*/*;q=0", reps);
  assert.equal(r.status, "not_acceptable");
  assert.equal(r.selected, null);
});

test("协商：无匹配类型不可接受", () => {
  const r = negotiate("image/png", reps);
  assert.equal(r.status, "not_acceptable");
});

test("协商：未提供 Accept 允许任意类型，按服务端优先级选", () => {
  const r = negotiate(null, reps);
  assert.equal(r.selected!.representationId, 1);
});

test("协商：显式空 Accept 全部不可接受（约定）", () => {
  const r = negotiate("", reps);
  assert.equal(r.status, "not_acceptable");
});

test("协商：大小写混合的媒体类型可匹配", () => {
  const r = negotiate("Application/JSON", reps);
  assert.equal(r.selected!.representationId, 1);
});
