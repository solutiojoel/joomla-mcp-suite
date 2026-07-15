import type { Response } from "express";

// Error envelope per docs/agent-runtime-api.md §1:
//   { "error": { "code": "<machine_code>", "message": "<human message>" } }
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "limit_exceeded"
  | "busy"
  | "upstream_unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function sendError(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>
): void {
  res.status(status).json({ error: { code, message }, ...(extra || {}) });
}
