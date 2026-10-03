// 协商引擎：为每个候选表示选择最具体的匹配范围，再用该范围的 q 排序。
import {
  MediaRange,
  parseAccept,
  specificity,
  AcceptSyntaxError,
  UnsupportedSyntaxError,
} from "./accept.js";

export interface Representation {
  id: number;
  mediaType: string; // 例如 "text/plain"（不含参数）
  params: Record<string, string>; // 例如 { charset: "utf-8" }
  priority: number; // 服务端优先顺序，数值小者优先
  body: string;
}

export interface CandidateReport {
  representationId: number;
  mediaType: string;
  params: Record<string, string>;
  priority: number;
  matchedRange: string | null;
  rangeParamCount: number | null;
  specificity: number | null;
  q: number | null;
  accepted: boolean;
  reason: string;
}

export interface NegotiationResult {
  status: "selected" | "not_acceptable";
  selected: CandidateReport | null;
  candidates: CandidateReport[];
}

export { AcceptSyntaxError, UnsupportedSyntaxError };

function parseMediaType(fullType: string): { type: string; subtype: string } {
  const slash = fullType.indexOf("/");
  return {
    type: fullType.slice(0, slash).toLowerCase(),
    subtype: fullType.slice(slash + 1).toLowerCase(),
  };
}

function rangeMatches(range: MediaRange, rep: Representation): boolean {
  const mt = parseMediaType(rep.mediaType);
  if (range.type !== "*" && range.type !== mt.type) return false;
  if (range.subtype !== "*" && range.subtype !== mt.subtype) return false;
  // 带参数的范围要求候选具备相同参数（参数名小写比较，值大小写不敏感）
  for (const [k, v] of Object.entries(range.params)) {
    const repVal = rep.params[k];
    if (repVal === undefined || repVal.toLowerCase() !== v.toLowerCase())
      return false;
  }
  return true;
}

// 为候选选择最具体的匹配范围：具体性高者优先；同级参数多者优先；
// 仍并列时取头中先出现者（稳定规则）。
function bestRangeFor(
  rep: Representation,
  ranges: MediaRange[]
): MediaRange | null {
  let best: MediaRange | null = null;
  for (const r of ranges) {
    if (!rangeMatches(r, rep)) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const sNew = specificity(r);
    const sBest = specificity(best);
    const pNew = Object.keys(r.params).length;
    const pBest = Object.keys(best.params).length;
    if (
      sNew > sBest ||
      (sNew === sBest && pNew > pBest) ||
      (sNew === sBest && pNew === pBest && r.index < best.index)
    ) {
      best = r;
    }
  }
  return best;
}

// header 为 null 表示未提供 Accept（允许任意类型）；空字符串按约定视为
// “无任何可接受类型”，即每个候选匹配到 */*;q=0。
export function negotiate(
  header: string | null,
  reps: Representation[]
): NegotiationResult {
  const ranges: MediaRange[] =
    header === null
      ? [
          {
            raw: "*/*",
            type: "*",
            subtype: "*",
            params: {},
            q: 1,
            index: 0,
          },
        ]
      : header.trim() === ""
        ? [
            {
              raw: "*/*;q=0",
              type: "*",
              subtype: "*",
              params: {},
              q: 0,
              index: 0,
            },
          ]
        : parseAccept(header);

  const candidates: CandidateReport[] = reps.map((rep) => {
    const range = bestRangeFor(rep, ranges);
    if (range === null) {
      return {
        representationId: rep.id,
        mediaType: rep.mediaType,
        params: rep.params,
        priority: rep.priority,
        matchedRange: null,
        rangeParamCount: null,
        specificity: null,
        q: null,
        accepted: false,
        reason: "无任何媒体范围匹配该候选",
      };
    }
    const spec = specificity(range);
    if (range.q === 0) {
      return {
        representationId: rep.id,
        mediaType: rep.mediaType,
        params: rep.params,
        priority: rep.priority,
        matchedRange: range.raw,
        rangeParamCount: Object.keys(range.params).length,
        specificity: spec,
        q: 0,
        accepted: false,
        reason: `最具体匹配范围 "${range.raw}" 的 q=0，被显式排除`,
      };
    }
    return {
      representationId: rep.id,
      mediaType: rep.mediaType,
      params: rep.params,
      priority: rep.priority,
      matchedRange: range.raw,
      rangeParamCount: Object.keys(range.params).length,
      specificity: spec,
      q: range.q,
      accepted: true,
      reason: "可接受",
    };
  });

  // 排序：q 降序 → 具体性降序 → 范围参数数降序 → 服务端 priority 升序 → id 升序。
  const acceptable = candidates
    .filter((c) => c.accepted)
    .sort((a, b) => {
      if (b.q! !== a.q!) return b.q! - a.q!;
      if (b.specificity! !== a.specificity!)
        return b.specificity! - a.specificity!;
      const pa = a.rangeParamCount!;
      const pb = b.rangeParamCount!;
      if (pb !== pa) return pb - pa;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.representationId - b.representationId;
    });

  for (const c of candidates) {
    if (c.accepted && acceptable.length > 0 && c !== acceptable[0]) {
      c.reason = "可接受，但被更高优先级的候选胜出";
    }
  }

  if (acceptable.length === 0) {
    return { status: "not_acceptable", selected: null, candidates };
  }
  acceptable[0].reason = "被选中";
  return { status: "selected", selected: acceptable[0], candidates };
}
