import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { withOrchestrator } from "./mcp";
import { agentSetFor, type RuntimeUser } from "./users";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const AGENTS_DIR = path.join(REPO_ROOT, "config", "agents");
const JOBS_CATALOG_PATH = path.join(__dirname, "..", "jobs", "catalog.json");

interface AgentCard {
  id: string;
  title: string;
  description: string;
}

function titleCase(name: string): string {
  return name
    .split(/[-_]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** All non-hidden agents, mirroring the orchestrator's listAvailableAgents(). */
function listVisibleAgents(): AgentCard[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const results: AgentCard[] = [];
  const seen = new Set<string>();
  const addJson = (jsonPath: string) => {
    try {
      const def = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (def.hidden) return;
      const name: string = def.name || path.basename(jsonPath, ".json");
      if (seen.has(name)) return;
      seen.add(name);
      results.push({
        id: name,
        title: def.title || titleCase(name),
        description: def.description || "",
      });
    } catch {
      /* skip malformed defs */
    }
  };
  for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      addJson(path.join(AGENTS_DIR, entry.name));
    } else if (entry.isDirectory()) {
      addJson(path.join(AGENTS_DIR, entry.name, `${entry.name}.json`));
    }
  }
  return results;
}

function agentsForUser(user: RuntimeUser): AgentCard[] {
  const visible = listVisibleAgents();
  const allowed = agentSetFor(user);
  // super_shannon access implies switch-to-anything, matching the orchestrator.
  if (allowed.includes("super_shannon")) return visible;
  return visible.filter((a) => allowed.includes(a.id));
}

/** Job catalog is data, not code — populated in Phase 3 (jobs/catalog.json). */
function listJobs(): unknown[] {
  if (!fs.existsSync(JOBS_CATALOG_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(JOBS_CATALOG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const catalogRouter = Router();

catalogRouter.get("/api/catalog", async (req: Request, res: Response) => {
  const user = req.user!;
  // Tools and prompts come live from the orchestrator under the caller's own
  // bearer token, so they reflect exactly what their agent scope allows —
  // scoping stays orchestrator-enforced, never duplicated here.
  let tools: unknown[] = [];
  let prompts: unknown[] = [];
  try {
    await withOrchestrator(user.orchestratorToken, async (client) => {
      const toolsResult = await client.listTools();
      tools = (toolsResult.tools || []).map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema,
      }));
      try {
        const promptsResult = await client.listPrompts();
        prompts = (promptsResult.prompts || []).map((p) => ({
          name: p.name,
          description: p.description || "",
          arguments: p.arguments || [],
        }));
      } catch {
        prompts = [];
      }
    });
  } catch (err) {
    // Orchestrator down: still render agents/jobs so the home screen works.
    console.warn(
      `[catalog] orchestrator unavailable for ${user.email}: ${(err as Error).message}`
    );
  }
  res.json({ agents: agentsForUser(user), jobs: listJobs(), tools, prompts });
});

// ── Sites ──────────────────────────────────────────────────────────────────

const FTP_SITES_PATH =
  process.env.FTP_SITES_PATH ||
  path.join(REPO_ROOT, "apps", "ftp-mcp", "ftp-sites.json");

catalogRouter.get("/api/sites", (_req: Request, res: Response) => {
  if (!fs.existsSync(FTP_SITES_PATH)) {
    res.json([]);
    return;
  }
  const sites = JSON.parse(fs.readFileSync(FTP_SITES_PATH, "utf8"));
  const list = Object.keys(sites)
    .sort()
    .map((host) => {
      const slug = host.split(".")[0];
      return { url: `https://${host}`, slug, name: titleCase(slug) };
    });
  res.json(list);
});
