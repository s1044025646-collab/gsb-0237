import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { negotiate, parseAcceptHeader } from "./negotiation.js";
import type { Representation } from "./types.js";

const representations: Representation[] = [
  { id: "json", mediaType: "application/json", priority: 10, body: "{}" },
  { id: "utf8", mediaType: "text/plain; charset=utf-8", priority: 20, body: "utf8" },
  { id: "latin", mediaType: "text/plain; charset=iso-8859-1", priority: 30, body: "latin" },
];

describe("Accept 解析", () => {
  it("解析具体类型、通配符、参数和三位 q", () => {
    const ranges = parseAcceptHeader('application/json;q=0.5, text/*;q=0.250, */*;q=0.001');
    assert.equal(ranges.length, 3);
    assert.equal(ranges[0]?.specificity, "exact");
    assert.equal(ranges[1]?.specificity, "type");
    assert.equal(ranges[2]?.quality, 0.001);
  });

  it("不会在带引号逗号处分片", () => {
    const ranges = parseAcceptHeader('text/plain; charset="utf-8, variant"; q=0.7, application/json');
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0]?.parameters.charset, "utf-8, variant");
  });

  it("拒绝非法 q、超过三位小数和裸扩展", () => {
    assert.throws(() => parseAcceptHeader("application/json;q=1.2"), /q 必须/);
    assert.throws(() => parseAcceptHeader("application/json;q=0.1234"), /q 必须/);
    assert.throws(() => parseAcceptHeader("application/json; extension"), /不支持/);
  });
});

describe("媒体类型选择", () => {
  it("具体类型优先于 type/*，type/* 优先于 */*", () => {
    const report = negotiate(representations, "*/*;q=1, text/*;q=0.1, text/plain;charset=utf-8;q=0.5");
    const utf8 = report.candidates.find((item) => item.representationId === "utf8")!;
    assert.equal(utf8?.matchedRange?.specificity, "exact");
    assert.equal(utf8.effectiveQuality, 0.5);
    assert.equal(report.selectedRepresentationId, "json");
  });

  it("具体 q=0 不能被 */*;q=1 救回", () => {
    const report = negotiate(representations, "application/json;q=0, */*;q=1");
    assert.equal(report.status, 200);
    assert.equal(report.selectedRepresentationId, "utf8");
    const json = report.candidates.find((item) => item.representationId === "json");
    assert.equal(json?.accepted, false);
    assert.equal(json?.matchedRange?.specificity, "exact");
  });

  it("所有类型 q=0 时返回 406 且区别于语法错误", () => {
    const report = negotiate(representations, "*/*;q=0");
    assert.equal(report.status, 406);
    assert.equal(report.error?.code, "NO_ACCEPTABLE_REPRESENTATION");

    const invalid = negotiate(representations, "application/");
    assert.equal(invalid.status, 406);
    assert.equal(invalid.error?.code, "ACCEPT_SYNTAX_ERROR");
  });

  it("同分按服务端 priority 再按稳定 ID 决策", () => {
    const tied = [
      { id: "b", mediaType: "application/xml", priority: 10, body: "b" },
      { id: "a", mediaType: "text/plain", priority: 10, body: "a" },
    ];
    assert.equal(negotiate(tied, "*/*").selectedRepresentationId, "a");
    const priority = [
      { id: "low", mediaType: "application/xml", priority: 1, body: "low" },
      { id: "high", mediaType: "text/plain", priority: 2, body: "high" },
    ];
    assert.equal(negotiate(priority, "*/*").selectedRepresentationId, "low");
  });

  it("参数需匹配，媒体类型大小写不敏感而 charset 值大小写规范化", () => {
    const report = negotiate(representations, 'TEXT/PLAIN; CHARSET=UTF-8');
    assert.equal(report.selectedRepresentationId, "utf8");
    const otherCharset = negotiate(representations, "text/plain;charset=utf-16");
    assert.equal(otherCharset.status, 406);
    assert.equal(otherCharset.error?.code, "NO_ACCEPTABLE_REPRESENTATION");
  });

  it("缺少 Accept 接受任意类型，显式空 Accept 返回 EMPTY_ACCEPT", () => {
    assert.equal(negotiate(representations, undefined).selectedRepresentationId, "json");
    const empty = negotiate(representations, "");
    assert.equal(empty.error?.code, "EMPTY_ACCEPT");
  });
});
