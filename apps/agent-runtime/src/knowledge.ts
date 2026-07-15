import { Router, type NextFunction, type Request, type Response } from "express";
import { ApiError, sendError, type ErrorCode } from "./http";
import { gatewayFetch, type GatewayResult } from "./gateway";

/**
 * Knowledge base proxy per API doc §7 — passes through to the Knowledge
 * Gateway with the server-held API key. Collections: knowledge (universal),
 * client-knowledge (per-site), self-improving (per-tool instructions), plus
 * the read-only audit log. Updates arrive as PUT from the frontend and go
 * upstream as PATCH (the gateway's verb).
 */

const COLLECTIONS = new Set(["knowledge", "client-knowledge", "self-improving"]);

export const knowledgeRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof ApiError) {
        return sendError(res, err.status, err.code, err.message, err.extra);
      }
      // Gateway unreachable / timed out
      sendError(res, 502, "upstream_unavailable", `Knowledge Gateway error: ${(err as Error).message}`);
    });
  };
}

function requireCollection(req: Request): string {
  const collection = String(req.params.collection);
  if (!COLLECTIONS.has(collection)) {
    throw new ApiError(404, "not_found", `No such knowledge collection: ${collection}`);
  }
  return collection;
}

/** Forward the gateway's response; wrap upstream errors in our envelope. */
function relay(res: Response, result: GatewayResult): void {
  if (result.status < 400) {
    res.status(result.status).json(result.body);
    return;
  }
  const upstream = result.body as { error?: string; message?: string } | null;
  const message = upstream?.error || upstream?.message || `Knowledge Gateway returned ${result.status}`;
  const code: ErrorCode =
    result.status === 404 ? "not_found" : result.status === 400 ? "validation" : "upstream_unavailable";
  sendError(res, result.status === 404 || result.status === 400 ? result.status : 502, code, message);
}

function q(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

// Audit is registered before /:collection so it never matches as a collection.
knowledgeRouter.get(
  "/api/knowledge/audit",
  wrap(async (req, res) => {
    relay(
      res,
      await gatewayFetch("GET", "/audit", {
        userEmail: req.user!.email,
        params: {
          table_name: q(req, "table_name"),
          action: q(req, "change_action") ?? q(req, "action"),
          tool_name: q(req, "tool_name"),
          limit: q(req, "limit"),
          offset: q(req, "offset"),
        },
      })
    );
  })
);

knowledgeRouter.get(
  "/api/knowledge/:collection",
  wrap(async (req, res) => {
    const collection = requireCollection(req);
    relay(
      res,
      await gatewayFetch("GET", `/${collection}`, {
        userEmail: req.user!.email,
        params: {
          tag: q(req, "tag"),
          search: q(req, "search"),
          topic: q(req, "topic"),
          site_code: q(req, "site_code"),
          tool_name: q(req, "tool_name"),
          limit: q(req, "limit"),
          offset: q(req, "offset"),
        },
      })
    );
  })
);

knowledgeRouter.post(
  "/api/knowledge/:collection",
  wrap(async (req, res) => {
    const collection = requireCollection(req);
    relay(
      res,
      await gatewayFetch("POST", `/${collection}`, {
        userEmail: req.user!.email,
        body: req.body ?? {},
      })
    );
  })
);

knowledgeRouter.get(
  "/api/knowledge/:collection/:id",
  wrap(async (req, res) => {
    const collection = requireCollection(req);
    relay(
      res,
      await gatewayFetch("GET", `/${collection}/${encodeURIComponent(String(req.params.id))}`, {
        userEmail: req.user!.email,
      })
    );
  })
);

knowledgeRouter.put(
  "/api/knowledge/:collection/:id",
  wrap(async (req, res) => {
    const collection = requireCollection(req);
    relay(
      res,
      await gatewayFetch("PATCH", `/${collection}/${encodeURIComponent(String(req.params.id))}`, {
        userEmail: req.user!.email,
        body: req.body ?? {},
      })
    );
  })
);

knowledgeRouter.delete(
  "/api/knowledge/:collection/:id",
  wrap(async (req, res) => {
    const collection = requireCollection(req);
    relay(
      res,
      await gatewayFetch("DELETE", `/${collection}/${encodeURIComponent(String(req.params.id))}`, {
        userEmail: req.user!.email,
      })
    );
  })
);
