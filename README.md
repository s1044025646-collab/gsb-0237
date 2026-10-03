# HTTP Accept 媒体类型协商实验服务

一个本机可运行的 HTTP 媒体类型协商（Content Negotiation）实验后端：管理虚构资源及其可提供的表示形式，根据请求的 `Accept` 头选出实际响应的媒体类型，并给出每个候选的匹配范围与淘汰原因。仅做媒体类型协商，不做语言/压缩协商，不代理请求，不是 API 网关。

- 技术栈：TypeScript + Node.js（内置 `http`、`node:sqlite`，零运行时依赖）
- 运行环境：Windows 本机，Node.js >= 22（建议 >= 24；`node:sqlite` 为实验特性，会有警告但不影响使用）
- 不依赖 Docker / WSL / 外部在线服务

## 快速开始

```powershell
npm install        # 仅安装 typescript 等开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 运行四种演示场景（通配 / 具体排除 / 不同 q / 全不接受）
npm start          # 启动 HTTP 服务（默认端口 0 = 自动选择空闲端口）
node dist/src/cli.js serve --port 8080   # 指定端口
```

数据保存在项目内 `./data/negotiation.db`（可用环境变量 `DATA_DIR` 修改）。首次 `serve` 或执行 `seed`/`demo` 时会自动写入演示资源 `demo`，包含三种表示：

| 表示 | 媒体类型 | 参数 | 服务端 priority |
|---|---|---|---|
| #1 | `application/json` | - | 1 |
| #2 | `text/plain` | - | 2 |
| #3 | `text/plain` | `charset=utf-8` | 3 |

## 支持的语法子集

手写解析器（`src/accept.ts`），未使用任何现成内容协商库：

- 逗号分隔的媒体范围列表；`type/subtype`、`type/*`、`*/*`
- 可选媒体参数（`q` 之前）：`name=value`，值可为 token 或带引号字符串；**带引号值中的逗号不会被误切开**（如 `note="a,b"`）
- 可选 `q` 值：默认 `1`，范围 `0`~`1`，最多三位小数（`0`、`0.001`、`1.000` 合法；`1.5`、`0.1234`、空值等为语法错误）
- 类型、子类型、参数名、`q` 名大小写不敏感；参数值比较大小写不敏感
- **不支持** q 之后的 accept-ext 参数（如 `a/b;q=0.5;level=1`），返回 `UNSUPPORTED_SYNTAX`；`*/非*` 形式同样视为不支持

## 协商与平局规则

1. 为每个候选表示找出**最具体的匹配范围**：精确类型 > `type/*` > `*/*`；同级时参数多的范围更具体；仍并列时取头中**先出现**者（稳定规则）。
2. 候选的 q 取该最具体范围的 q。因此 `application/json;q=0, */*;q=1` 中 JSON 被 q=0 排除，**不会被 `*/*` 救回**。
3. 带参数的范围只匹配具备相同参数的候选（如 `text/plain;charset=utf-8` 只匹配带 charset 的表示）。
4. q=0 的候选被淘汰；其余按 **q 降序 -> 范围具体性降序 -> 范围参数数降序 -> 服务端 priority 升序 -> 表示 id 升序** 排序，取第一名为选中项。
5. 无可接受表示时返回 **406**（错误码 `NO_ACCEPTABLE`），与语法错误（`INVALID_ACCEPT`）、不支持语法（`UNSUPPORTED_SYNTAX`）明确区分。

**空 Accept 约定**：未提供 `Accept` 头 = 接受任意类型（等价 `*/*`）；显式空 `Accept` 头 = 无任何可接受类型（等价 `*/*;q=0`，结果为 406）。

## HTTP API

所有错误响应为 `{"error": {"code": "...", "message": "..."}}`，错误码：`VALIDATION`、`INVALID_JSON`、`INVALID_ACCEPT`、`UNSUPPORTED_SYNTAX`、`NO_ACCEPTABLE`(406)、`NOT_FOUND`(404)、`INTERNAL`(500)。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/resources` | 新增资源 `{name}` |
| GET | `/resources` | 列出资源 |
| POST | `/resources/:id/representations` | 新增表示 `{mediaType, priority, params?, body?}` |
| GET | `/resources/:id/representations` | 列出表示 |
| DELETE | `/representations/:id` | 删除表示 |
| POST | `/parse` | 仅解析 Accept 头 `{header}` |
| GET | `/resources/:id/negotiate` | 用请求的 Accept 头协商，返回每候选报告（406 时也含报告） |
| GET | `/resources/:id/content` | 示例资源接口：返回选中表示的正文与 `Content-Type`，并设置 `Vary: Accept` |
| GET | `/reports`、`/reports/:id` | 查询历史协商报告（只增不改） |
| GET | `/config-versions`、`/config-versions/diff?from=1&to=2` | 配置版本列表与快照比较 |

示例（假设服务在 8123 端口，demo 资源 id=1）：

```powershell
curl.exe -i -H "Accept: text/plain;charset=utf-8" http://127.0.0.1:8123/resources/1/content
# HTTP/1.1 200 OK
# Content-Type: text/plain; charset=utf-8
# Vary: Accept

curl.exe -i -H "Accept: application/json;q=0, */*;q=0.5" http://127.0.0.1:8123/resources/1/negotiate
curl.exe -i -H "Accept: image/png" http://127.0.0.1:8123/resources/1/content   # 406
```

## CLI

```
node dist/src/cli.js serve [--port N]            # 默认端口 0 = 自动选空闲端口
node dist/src/cli.js seed                        # 写入演示资源
node dist/src/cli.js resource add <name> | list
node dist/src/cli.js rep add <resourceId> --type text/html --priority 4 [--param charset=utf-8] [--body "..."]
node dist/src/cli.js rep list <resourceId> | rep del <repId>
node dist/src/cli.js parse "text/html, */*;q=0.1"
node dist/src/cli.js negotiate 1 --header "text/plain;q=0.9, application/json;q=0.4"
node dist/src/cli.js report list [resourceId] | report show <reportId>
node dist/src/cli.js version list | version diff <from> <to>
node dist/src/cli.js demo
```

## 持久化与版本

- 每次配置修改（增删资源/表示）生成一个新的 `config_versions` 快照，可用 `version diff` / `/config-versions/diff` 比较任意两版。
- 每次协商保存一条 `reports`：资源 id、配置版本号、**原始 Accept 头**、完整协商结果 JSON、时间。报告只插入不更新，修改配置不会改写旧报告。

## 测试

`npm test` 覆盖：具体性选择、q=0 排除、同分稳定决策、大小写、带引号逗号、非法 q、缺少/显式空 Accept、示例接口状态码与 `Content-Type`/`Vary` 响应头、报告不可变、版本比较、参数校验错误码。

## 已知限制

- 不支持 q 之后的 accept-ext、不做 `Accept-Language`/`Accept-Encoding` 协商。
- 参数值比较按大小写不敏感处理（对 charset 等常见参数足够）。
- `node:sqlite` 在 Node 25 仍为实验特性，启动时会有 ExperimentalWarning。
- 单进程服务，未做并发写优化与鉴权，仅供本机实验。
