// Accept 请求头解析器（手写词法分析，支持带引号字符串中的逗号）。

export class AcceptSyntaxError extends Error {
  code = "INVALID_ACCEPT" as const;
}

export class UnsupportedSyntaxError extends Error {
  code = "UNSUPPORTED_SYNTAX" as const;
}

export interface MediaRange {
  raw: string; // 原始片段（trim 后）
  type: string; // 小写
  subtype: string; // 小写
  params: Record<string, string>; // 媒体参数（q 之前），名小写
  q: number;
  index: number; // 在头中出现的顺序，用于稳定平局
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const Q_RE = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/;

// 按顶层逗号切分，忽略双引号内（含 \" 转义）的逗号。
export function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuote) {
      buf += c;
      if (c === "\\" && i + 1 < input.length) {
        buf += input[++i];
      } else if (c === '"') {
        inQuote = false;
      }
    } else if (c === '"') {
      inQuote = true;
      buf += c;
    } else if (c === sep) {
      parts.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (inQuote) throw new AcceptSyntaxError("引号未闭合");
  parts.push(buf);
  return parts;
}

function unquote(v: string): string {
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"'))
      throw new AcceptSyntaxError(`参数值引号未闭合: ${v}`);
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

function parseParam(segment: string): [string, string] {
  const eq = segment.indexOf("=");
  if (eq <= 0)
    throw new AcceptSyntaxError(`参数缺少 '=' : "${segment.trim()}"`);
  const name = segment.slice(0, eq).trim().toLowerCase();
  const value = segment.slice(eq + 1).trim();
  if (!TOKEN.test(name))
    throw new AcceptSyntaxError(`非法参数名: "${name}"`);
  if (value === "")
    throw new AcceptSyntaxError(`参数 "${name}" 缺少值`);
  if (!value.startsWith('"') && !TOKEN.test(value))
    throw new AcceptSyntaxError(`非法参数值: "${value}"`);
  return [name, unquote(value)];
}

export function parseAccept(header: string): MediaRange[] {
  const items = splitTopLevel(header, ",");
  const ranges: MediaRange[] = [];
  items.forEach((item, index) => {
    const raw = item.trim();
    if (raw === "")
      throw new AcceptSyntaxError("存在空的媒体范围（多余逗号）");
    const segments = splitTopLevel(raw, ";").map((s) => s.trim());
    const fullType = segments[0].toLowerCase();
    const slash = fullType.indexOf("/");
    if (slash <= 0 || slash !== fullType.lastIndexOf("/"))
      throw new AcceptSyntaxError(`非法媒体类型: "${segments[0]}"`);
    const type = fullType.slice(0, slash);
    const subtype = fullType.slice(slash + 1);
    if (type !== "*" && !TOKEN.test(type))
      throw new AcceptSyntaxError(`非法 type: "${type}"`);
    if (subtype !== "*" && !TOKEN.test(subtype))
      throw new AcceptSyntaxError(`非法 subtype: "${subtype}"`);
    if (type === "*" && subtype !== "*")
      throw new UnsupportedSyntaxError(`不支持 "*/非*" 形式: "${fullType}"`);

    const params: Record<string, string> = {};
    let q = 1;
    let qSeen = false;
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === "") throw new AcceptSyntaxError("存在空参数（多余分号）");
      const [name, value] = parseParam(seg);
      if (!qSeen && name === "q") {
        qSeen = true;
        if (!Q_RE.test(value))
          throw new AcceptSyntaxError(
            `非法 q 值: "${value}"（须为 0~1，最多三位小数）`
          );
        q = Number(value);
      } else if (qSeen) {
        throw new UnsupportedSyntaxError(
          `不支持 q 之后的 accept-ext 参数: "${name}"`
        );
      } else {
        if (name in params)
          throw new AcceptSyntaxError(`重复参数: "${name}"`);
        params[name] = value;
      }
    }
    ranges.push({ raw, type, subtype, params, q, index });
  });
  return ranges;
}

// 具体性：精确类型=2，type/*=1，star/*=0
export function specificity(r: MediaRange): number {
  if (r.type === "*") return 0;
  if (r.subtype === "*") return 1;
  return 2;
}
