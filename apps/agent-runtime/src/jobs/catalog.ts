import fs from "node:fs";
import path from "node:path";

/**
 * Job catalog is data, not code: jobs/catalog.json holds one entry per
 * agents-mcp tool with its input schema transcribed (pdf_path fields exposed
 * as `format: runtime-file-id` and resolved server-side). New tools appear in
 * the frontend by editing that file — no code changes.
 */

export interface JobDef {
  id: string;
  title: string;
  description: string;
  kind: "llm" | "deterministic";
  /** Sub-agent name in the agents-mcp run monitor (runId resolution), or null. */
  subAgent: string | null;
  /** Orchestrator agent scopes whose tools.allow include this tool; the worker
   *  switches to the first scope the user is permitted to use. */
  agentScopes: string[];
  stoppable: boolean;
  /** Hidden entries (admin smoke tests) are runnable but not listed. */
  hidden?: boolean;
  produces: string[];
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<
      string,
      {
        type?: string;
        format?: string;
        description?: string;
        "x-tool-arg"?: string;
        items?: { type?: string };
      }
    >;
  };
}

const CATALOG_PATH = path.join(__dirname, "..", "..", "jobs", "catalog.json");

let cache: { mtimeMs: number; defs: JobDef[] } | null = null;

export function jobDefs(): JobDef[] {
  try {
    const mtimeMs = fs.statSync(CATALOG_PATH).mtimeMs;
    if (!cache || cache.mtimeMs !== mtimeMs) {
      cache = { mtimeMs, defs: JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as JobDef[] };
    }
    return cache.defs;
  } catch {
    return [];
  }
}

export function jobDef(id: string): JobDef | undefined {
  return jobDefs().find((d) => d.id === id);
}

/** Contract shape for GET /api/catalog — hidden entries and internal fields omitted. */
export function jobCards(): Array<Record<string, unknown>> {
  return jobDefs()
    .filter((d) => !d.hidden)
    .map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      kind: d.kind,
      inputSchema: d.inputSchema,
      produces: d.produces,
    }));
}
