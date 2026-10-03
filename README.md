# Accept 媒体类型协商实验服务

这是一个只做 HTTP `Accept` 媒体类型协商的 Windows 本地后端。项目使用 TypeScript、Node.js 和 Node 内置 `node:sqlite`，不需要 Docker、WSL、付费服务、外部在线 API 或原生第三方数据库驱动。

## 环境

- Windows PowerShell
- Node.js 25 或更高版本（需要内置 `node:sqlite`）
- 数据默认保存在项目内 `data/accept-lab.sqlite`

## 构建、测试、启动

```powershell
npm install
npm run build
npm test
npm start
```

`npm start` 默认选择 `127.0.0.1` 的空闲端口，并在控制台打印实际地址。也可以指定：

```powershell
npm start -- --port 5173 --host 127.0.0.1 --data-dir .\data
```

运行可复制的端到端演示：

```powershell
npm run demo
```

## 支持的 Accept 子集

支持：

- 逗号分隔的多个媒体范围：`application/json, text/plain`
- 精确类型：`text/plain`
- 子类型通配：`text/*`
- 全通配：`*/*`
- `q` 参数：`application/json;q=0.8`
- 有限媒体参数：`text/plain; charset=utf-8`
- 参数值中的引号与引号内逗号：`text/plain; charset="utf-8, demo"`

不支持语言协商、编码压缩协商、Accept-Extension、参数值注释、HTTP 缓存验证、代理转发和网站抓取。裸参数如 `application/json; extension` 返回 `UNSUPPORTED_ACCEPT_SYNTAX`，不会当成匹配失败。

## 协商规则

1. 每个候选只选择一个**最具体**的匹配范围：精确类型优先于 `type/*`，后者优先于 `*/*`。
2. 使用这个最具体范围的 `q` 作为候选有效质量；没有匹配范围时有效质量为 0。
3. 精确范围 `q=0` 会排除该候选，不能被更宽泛的 `*/*;q=1` 救回。
4. 可接受候选按有效 `q` 降序排列；同分时按服务端 `priority` 升序；仍同分按表示 ID 的 ASCII 字典序。
5. `type/subtype`、参数名和 `charset` 参数值按大小写不敏感比较；其他参数值区分大小写。
6. `q` 默认 1，只接受 `0` 到 `1`，小数最多三位：`0.123` 合法，`0.1234` 非法。
7. 带非 `q` 参数的范围要求候选拥有同名同值参数；候选可以有额外参数。
8. 缺少 `Accept` 等于接受任意可提供类型。显式发送 `Accept:`（空值）表示空集合，返回 406 和 `EMPTY_ACCEPT`。

语法错误返回 `ACCEPT_SYNTAX_ERROR`；使用本子集外的语法返回 `UNSUPPORTED_ACCEPT_SYNTAX`；语法合法但无候选返回 `NO_ACCEPTABLE_REPRESENTATION`。三者互不混淆。

## API 示例

创建资源：

```powershell
$body = @'
{
  "id": "demo",
  "path": "/demo",
  "representations": [
    {"id":"json", "mediaType":"application/json", "priority":10, "body":"{\"ok\":true}"},
    {"id":"utf8", "mediaType":"text/plain; charset=utf-8", "priority":20, "body":"hello"},
    {"id":"latin", "mediaType":"text/plain; charset=iso-8859-1", "priority":30, "body":"latin"}
  ]
}
'@
Invoke-RestMethod -Uri http://127.0.0.1:5173/api/resources -Method Post -ContentType 'application/json' -Body $body
```

实际媒体接口会返回选中的正文、`Content-Type` 和 `Vary: Accept`：

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:5173/demo -Headers @{ Accept = 'text/plain;charset=utf-8' }
```

查看完整解释报告：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:5173/api/negotiate -Method Post -ContentType 'application/json' -Body '{"resourceId":"demo","accept":"application/json;q=0, */*;q=1"}'
```

其他接口：

- `GET /health`
- `GET /api/resources`
- `GET /api/resources/:id`
- `PUT /api/resources/:id` 创建新配置版本
- `GET /api/resources/:id/versions`
- `GET /api/resources/:id/versions/:version`
- `GET /api/history?limit=50`

配置每次修改都会生成新版本。历史报告保存当时的版本号和完整 JSON 报告；后续修改配置不会覆盖旧报告。

## CLI 示例

构建后可直接运行：

```powershell
node .\dist\cli.js init demo --path /demo
node .\dist\cli.js parse --header 'application/json;q=0, */*;q=1'
node .\dist\cli.js negotiate demo --header 'text/plain;charset=utf-8'
node .\dist\cli.js versions demo
node .\dist\cli.js diff demo 1 2
node .\dist\cli.js history demo
```

`init` 默认创建 JSON、UTF-8 文本和 Latin-1 文本三个表示，便于快速实验。

## 错误码

- `VALIDATION_ERROR`：请求字段缺失或格式不对，HTTP 400
- `INVALID_JSON`：请求体不是合法 JSON，HTTP 400
- `RESOURCE_NOT_FOUND` / `VERSION_NOT_FOUND` / `ROUTE_NOT_FOUND`，HTTP 404
- `EMPTY_ACCEPT`、`ACCEPT_SYNTAX_ERROR`、`UNSUPPORTED_ACCEPT_SYNTAX`、`NO_ACCEPTABLE_REPRESENTATION`，HTTP 406

## 限制

本项目是教学实验服务：只解释 `Accept`，不识别质量值以外的完整 RFC 偏好，不生成多版本正文，不做权限认证，也不应直接暴露到公网。
