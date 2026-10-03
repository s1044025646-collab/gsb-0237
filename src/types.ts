export type ParamMap = Record<string, string>;

export interface MediaType {
  type: string;
  subtype: string;
  parameters: ParamMap;
  quality: number;
}

export interface AcceptRange extends MediaType {
  position: number;
  raw: string;
  specificity: "exact" | "type" | "all";
}

export interface Representation {
  id: string;
  mediaType: string;
  priority: number;
  body: string;
}

export interface CandidateReport {
  representationId: string;
  mediaType: string;
  serverPriority: number;
  accepted: boolean;
  effectiveQuality: number;
  matchedRange?: {
    raw: string;
    position: number;
    specificity: "exact" | "type" | "all";
    quality: number;
  };
  reason: string;
}

export interface NegotiationReport {
  ok: boolean;
  status: 200 | 406;
  rawAcceptHeader: string | null;
  acceptPresent: boolean;
  selectedRepresentationId: string | null;
  selectedContentType: string | null;
  selectedBody: string | null;
  decision: string;
  candidates: CandidateReport[];
  error?: {
    code:
      | "ACCEPT_SYNTAX_ERROR"
      | "UNSUPPORTED_ACCEPT_SYNTAX"
      | "EMPTY_ACCEPT"
      | "NO_ACCEPTABLE_REPRESENTATION";
    message: string;
  };
}
