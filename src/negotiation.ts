import type {
  AcceptRange,
  CandidateReport,
  MediaType,
  NegotiationReport,
  ParamMap,
  Representation,
} from "./types.js";

export class AcceptParseError extends Error {
  constructor(
    public readonly code: "ACCEPT_SYNTAX_ERROR" | "UNSUPPORTED_ACCEPT_SYNTAX",
    message: string,
  ) {
    super(message);
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function splitMediaList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      current += char;
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === "," && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (quoted || escaped) {
    throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "带引号参数未正确结束");
  }
  parts.push(current);
  return parts;
}

function splitParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      current += char;
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (quoted || escaped) {
    throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "带引号参数未正确结束");
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (!trimmed.endsWith('"') || trimmed.length < 2) {
    throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "引号没有闭合");
  }
  return trimmed
    .slice(1, -1)
    .replace(/\\(.)/g, (_, char: string) => char);
}

function normalizeParameter(name: string, value: string): [string, string] {
  const key = name.toLowerCase();
  const normalizedValue = key === "charset" ? value.toLowerCase() : value;
  return [key, normalizedValue];
}

export function parseMediaType(value: string, allowQuality = false): MediaType {
  const pieces = splitParameters(value);
  const main = pieces[0]?.trim();
  if (!main) throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "媒体类型为空");
  const [typeText, subtypeText, ...extraMain] = main.split("/");
  if (!typeText || !subtypeText || extraMain.length > 0) {
    throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "媒体类型必须是 type/subtype");
  }
  const type = typeText.trim().toLowerCase();
  const subtype = subtypeText.trim().toLowerCase();
  if (!TOKEN.test(type) || !TOKEN.test(subtype)) {
    throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "type 或 subtype 包含非法字符");
  }

  const parameters: ParamMap = {};
  let quality = 1;
  for (const rawParameter of pieces.slice(1)) {
    const parameter = rawParameter.trim();
    if (!parameter) {
      throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "存在空参数");
    }
    const equals = parameter.indexOf("=");
    if (equals <= 0) {
      throw new AcceptParseError(
        "UNSUPPORTED_ACCEPT_SYNTAX",
        "本子集仅支持 name=value 媒体参数，不支持裸 Accept 扩展",
      );
    }
    const name = parameter.slice(0, equals).trim();
    const rawValue = parameter.slice(equals + 1);
    if (!TOKEN.test(name)) {
      throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "参数名非法");
    }
    const valueText = unquote(rawValue);
    const key = name.toLowerCase();
    if (key === "q") {
      if (!allowQuality) {
        throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "候选媒体类型不能包含 q 参数");
      }
      if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(valueText)) {
        throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "q 必须是 0 到 1 且最多三位小数");
      }
      quality = Number(valueText);
    } else {
      const [normalizedName, normalizedValue] = normalizeParameter(name, valueText);
      if (normalizedName in parameters) {
        throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", `参数 ${normalizedName} 重复`);
      }
      parameters[normalizedName] = normalizedValue;
    }
  }

  return { type, subtype, parameters, quality };
}

export function parseAcceptHeader(header: string): AcceptRange[] {
  if (header.trim() === "") return [];
  return splitMediaList(header)
    .map((piece, position) => {
      const raw = piece.trim();
      if (!raw) {
        throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "Accept 列表包含空媒体范围");
      }
      const media = parseMediaType(raw, true);
      const specificity: AcceptRange["specificity"] =
        media.type === "*" && media.subtype === "*"
          ? "all"
          : media.subtype === "*"
            ? "type"
            : "exact";
      if (media.subtype === "*" && media.type === "*") {
        // */* 合法
      } else if (media.subtype === "*") {
        // type/* 合法
      } else if (media.type === "*") {
        throw new AcceptParseError("ACCEPT_SYNTAX_ERROR", "仅支持 type/* 或 */* 通配符");
      }
      return { ...media, position, raw, specificity };
    })
    .sort((left, right) => left.position - right.position);
}

function parametersMatch(range: AcceptRange, candidate: MediaType): boolean {
  return Object.entries(range.parameters).every(
    ([name, value]) => candidate.parameters[name] === value,
  );
}

function specificityRank(specificity: AcceptRange["specificity"]): number {
  return specificity === "exact" ? 3 : specificity === "type" ? 2 : 1;
}

function selectRange(candidate: MediaType, ranges: AcceptRange[]): AcceptRange | null {
  const matches = ranges.filter((range) => {
    if (range.specificity === "all") return parametersMatch(range, candidate);
    if (range.specificity === "type") {
      return range.type === candidate.type && parametersMatch(range, candidate);
    }
    return (
      range.type === candidate.type &&
      range.subtype === candidate.subtype &&
      parametersMatch(range, candidate)
    );
  });
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => {
    const bestRank = specificityRank(best.specificity);
    const currentRank = specificityRank(current.specificity);
    if (currentRank > bestRank) return current;
    if (currentRank === bestRank && current.position < best.position) return current;
    return best;
  });
}

function stableRepresentations(representations: Representation[]): Representation[] {
  return [...representations].sort(
    (left, right) =>
      left.priority - right.priority ||
      left.id.localeCompare(right.id, "en") ||
      left.mediaType.localeCompare(right.mediaType, "en"),
  );
}

export function negotiate(
  representations: Representation[],
  rawAcceptHeader: string | undefined | null,
): NegotiationReport {
  const acceptPresent = rawAcceptHeader !== undefined && rawAcceptHeader !== null;
  if (acceptPresent && rawAcceptHeader!.trim() === "") {
    return {
      ok: false,
      status: 406,
      rawAcceptHeader: rawAcceptHeader!,
      acceptPresent: true,
      selectedRepresentationId: null,
      selectedContentType: null,
      selectedBody: null,
      decision: "显式空 Accept 不包含任何媒体范围，按 406 处理",
      candidates: [],
      error: { code: "EMPTY_ACCEPT", message: "Accept 标头存在但值为空" },
    };
  }

  let ranges: AcceptRange[] = [];
  if (acceptPresent) {
    try {
      ranges = parseAcceptHeader(rawAcceptHeader!);
    } catch (error) {
      const parsed = error as AcceptParseError;
      return {
        ok: false,
        status: 406,
        rawAcceptHeader: rawAcceptHeader!,
        acceptPresent: true,
        selectedRepresentationId: null,
        selectedContentType: null,
        selectedBody: null,
        decision: "Accept 标头无法解析，未执行候选匹配",
        candidates: [],
        error: { code: parsed.code, message: parsed.message },
      };
    }
  }

  const candidateReports: CandidateReport[] = stableRepresentations(representations).map(
    (representation) => {
      const candidate = parseMediaType(representation.mediaType, false);
      const range = acceptPresent ? selectRange(candidate, ranges) : null;
      const quality = acceptPresent ? (range?.quality ?? 0) : 1;
      const accepted = quality > 0;
      return {
        representationId: representation.id,
        mediaType: representation.mediaType,
        serverPriority: representation.priority,
        accepted,
        effectiveQuality: quality,
        ...(range
          ? {
              matchedRange: {
                raw: range.raw,
                position: range.position,
                specificity: range.specificity,
                quality: range.quality,
              },
            }
          : {}),
        reason: !acceptPresent
          ? "缺少 Accept，按任意可提供类型接受，q=1"
          : !range
            ? "没有任何范围匹配此候选"
            : range.quality === 0
              ? `被最具体匹配范围 ${range.specificity} 以 q=0 排除，宽泛范围不能救回`
              : `匹配 ${range.specificity} 范围，有效 q=${range.quality}`,
      };
    },
  );

  const accepted = candidateReports
    .filter((candidate) => candidate.accepted)
    .sort(
      (left, right) =>
        right.effectiveQuality - left.effectiveQuality ||
        left.serverPriority - right.serverPriority ||
        left.representationId.localeCompare(right.representationId, "en"),
    );
  const winner = accepted[0];
  if (!winner) {
    return {
      ok: false,
      status: 406,
      rawAcceptHeader: acceptPresent ? rawAcceptHeader! : null,
      acceptPresent,
      selectedRepresentationId: null,
      selectedContentType: null,
      selectedBody: null,
      decision: "所有候选未匹配或被 q=0 排除",
      candidates: candidateReports,
      error: {
        code: "NO_ACCEPTABLE_REPRESENTATION",
        message: "没有可接受的表示形式",
      },
    };
  }

  const representation = representations.find((item) => item.id === winner.representationId)!;
  return {
    ok: true,
    status: 200,
    rawAcceptHeader: acceptPresent ? rawAcceptHeader! : null,
    acceptPresent,
    selectedRepresentationId: representation.id,
    selectedContentType: representation.mediaType,
    selectedBody: representation.body,
    decision: `先取每个候选的最具体匹配范围，再按有效 q 降序、服务端 priority 升序、ID 字典序选择`,
    candidates: candidateReports,
  };
}
