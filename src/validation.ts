import { parseMediaType } from "./negotiation.js";
import type { Representation } from "./types.js";

export interface RepresentationRequest {
  id?: unknown;
  mediaType?: unknown;
  priority?: unknown;
  body?: unknown;
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error(`${field} 必须是非空字符串`), {
      code: "VALIDATION_ERROR",
      field,
    });
  }
  return value;
}

export function validateRepresentations(value: unknown): Representation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw Object.assign(new Error("representations 必须是非空数组"), {
      code: "VALIDATION_ERROR",
      field: "representations",
    });
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `representations[${index}]`;
    if (!item || typeof item !== "object") {
      throw Object.assign(new Error(`${field} 必须是对象`), {
        code: "VALIDATION_ERROR",
        field,
      });
    }
    const input = item as RepresentationRequest;
    const id = assertString(input.id ?? `rep-${index + 1}`, `${field}.id`).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw Object.assign(new Error(`${field}.id 格式非法`), {
        code: "VALIDATION_ERROR",
        field: `${field}.id`,
      });
    }
    if (seen.has(id)) {
      throw Object.assign(new Error(`表示 ID 重复: ${id}`), {
        code: "VALIDATION_ERROR",
        field: `${field}.id`,
      });
    }
    seen.add(id);

    const mediaType = assertString(input.mediaType, `${field}.mediaType`).trim();
    try {
      parseMediaType(mediaType, false);
    } catch (error) {
      throw Object.assign(new Error((error as Error).message), {
        code: "VALIDATION_ERROR",
        field: `${field}.mediaType`,
      });
    }

    if (typeof input.priority !== "number" || !Number.isInteger(input.priority) || input.priority < 0) {
      throw Object.assign(new Error(`${field}.priority 必须是非负整数`), {
        code: "VALIDATION_ERROR",
        field: `${field}.priority`,
      });
    }
    if (input.body !== undefined && typeof input.body !== "string") {
      throw Object.assign(new Error(`${field}.body 必须是字符串`), {
        code: "VALIDATION_ERROR",
        field: `${field}.body`,
      });
    }
    return { id, mediaType, priority: input.priority, body: input.body ?? "" };
  });
}

export function validateResourceId(value: unknown): string {
  const id = assertString(value, "resourceId").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw Object.assign(new Error("resourceId 格式非法"), {
      code: "VALIDATION_ERROR",
      field: "resourceId",
    });
  }
  return id;
}
