import axiosLib, { AxiosInstance } from "axios";

export interface GatewayResponse {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  /** Tags audit-log entries via the X-Tool-Name header. */
  toolName?: string;
}

/** Filters for listing universal/client knowledge. */
export interface KnowledgeListFilters {
  site_code?: string;
  topic?: string;
  tag?: string;
  search?: string;
  limit?: number;
  offset?: number;
  /** Return id/topic/tags/length per row instead of the full body. */
  summary?: boolean;
}

/** Body fields for creating/updating universal or client knowledge. */
export interface KnowledgeFields {
  site_code?: string;
  topic?: string;
  content?: string;
  tags?: string[];
  content_type?: string;
}

/** Filters for listing self-improving instructions. */
export interface SelfImprovingListFilters {
  tool_name?: string;
  search?: string;
}

/** Body fields for creating/updating self-improving instructions. */
export interface SelfImprovingFields {
  tool_name?: string;
  instruction?: string;
  notes?: string;
  change_reason?: string;
}

/** Filters for the audit log. */
export interface AuditListFilters {
  table_name?: string;
  tool_name?: string;
  action?: string;
  limit?: number;
  offset?: number;
}

/** Filters for listing agent-audit session records. */
export interface AgentAuditListFilters {
  site_code?: string;
  agent_id?: string;
  limit?: number;
  offset?: number;
  /** Return the full originalRequest/taskNotes bodies instead of the summary projection. */
  full?: boolean;
}

/** Body fields for creating an agent-audit session record. */
export interface AgentAuditFields {
  site_code?: string;
  agent_id?: string;
  task?: string;
  original_request?: string;
  task_notes?: string;
  user_id?: string;
}

/** Drop undefined values so we never send empty query params or body keys. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Join an existing body and an addition with exactly one blank line between
 * them, so repeated appends can't accumulate trailing whitespace.
 */
function joinAppended(existing: string, addition: string): string {
  const head = existing.replace(/\s+$/, "");
  const tail = addition.replace(/^\s+/, "").replace(/\s+$/, "");
  if (!head) return tail;
  if (!tail) return head;
  return `${head}\n\n${tail}`;
}

/**
 * A content PATCH the gateway refuses twice in a row with 403 while GET and a
 * tags-only PATCH on the same record still succeed. Gateway-side; not a
 * content, size, or permissions problem on this end.
 */
class PersistentPatchRefusal extends Error {
  constructor(public readonly path: string) {
    super(
      `Knowledge Gateway refused a content write to ${path} with 403 twice in a row, ` +
      `while GET and a tags-only update on the same record still succeed. ` +
      `This is a known gateway-side condition, not a content, size, or permissions problem — ` +
      `retrying will not clear it. Do NOT try the create + delete + retag swap: it has reproduced ` +
      `the same refusal on every replacement row. Publish the change under a new record instead, ` +
      `and escalate for direct database access on shannon-data.`
    );
    this.name = "PersistentPatchRefusal";
  }
}

export class GatewayClient {
  private readonly axios: AxiosInstance;

  constructor(config: GatewayConfig) {
    this.axios = axiosLib.create({
      baseURL: config.baseUrl.replace(/\/+$/, ""),
      headers: {
        "X-Api-Key": config.apiKey,
        "X-Tool-Name": config.toolName ?? "joomla-mcp-suite",
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
  }

  private wrapError(error: unknown): GatewayResponse {
    // Already carries its own diagnosis — do not bury it under "Unexpected error".
    if (error instanceof PersistentPatchRefusal) {
      return { success: false, message: error.message };
    }
    if (axiosLib.isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data as Record<string, unknown> | undefined;
      const msg =
        (body?.error as string) ||
        (body?.message as string) ||
        error.message;
      return {
        success: false,
        message: `Knowledge Gateway API error ${status ?? "unknown"}: ${msg}`,
      };
    }
    return { success: false, message: `Unexpected error: ${String(error)}` };
  }

  /**
   * PATCH a record, retrying once on a 403.
   *
   * The gateway refuses content PATCHes with a bare 403 in two shapes. One is
   * transient and clears on an immediate retry — the retry here absorbs it
   * silently. The other is persistent on specific rows: GET and a tags-only
   * PATCH keep working while every content PATCH is refused, forever. That one
   * is a gateway-side condition no client change fixes, so say exactly that
   * instead of leaving a bare 403 to be re-diagnosed, and warn off the
   * create/delete/retag swap, which has reproduced the same lock on every
   * replacement row it was tried on.
   */
  private async patchRecord(path: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const { data } = await this.axios.patch(path, body);
      return data;
    } catch (first) {
      if (!axiosLib.isAxiosError(first) || first.response?.status !== 403) throw first;
      try {
        const { data } = await this.axios.patch(path, body);
        return data;
      } catch (second) {
        if (!axiosLib.isAxiosError(second) || second.response?.status !== 403) throw second;
        const tagsOnly = Object.keys(body).every((k) => k === "tags");
        if (tagsOnly) throw second;
        throw new PersistentPatchRefusal(path);
      }
    }
  }

  /**
   * Shared paging and projection for the two knowledge lists.
   *
   * Neither /knowledge nor /client-knowledge accepts limit or offset, and both
   * return every matching row with its full body. Once the workflow guides and
   * KB articles moved into /knowledge, an unfiltered list ran past 250k
   * characters — far more than a caller can hold. Page here instead.
   *
   * Bodies stay in the response by default. The support agent loads its
   * workflow straight out of `list` (tag: "workflow"), so a summary default
   * would break it. Callers browsing the catalogue pass summary:true.
   */
  private pageKnowledge(
    data: unknown,
    label: string,
    filters: KnowledgeListFilters,
  ): GatewayResponse {
    const all = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const offset = Math.max(0, filters.offset ?? 0);
    const rows =
      filters.limit === undefined
        ? all.slice(offset)
        : all.slice(offset, offset + Math.max(0, filters.limit));
    // Tell the caller when they hold a window rather than the lot, otherwise a
    // paged list reads as "these are all the entries there are".
    const range =
      rows.length === all.length ? "" : ` (${offset + 1}-${offset + rows.length} of ${all.length})`;

    if (!filters.summary) {
      return { success: true, message: `${label} listed — ${rows.length} record(s)${range}`, data: rows };
    }
    return {
      success: true,
      message: `${label} listed — ${rows.length} record(s), summary only${range}; use action 'get' for the body`,
      data: rows.map((r) => ({
        id: r.id,
        siteCode: r.siteCode,
        topic: r.topic,
        tags: r.tags,
        contentType: r.contentType,
        contentLength: typeof r.content === "string" ? r.content.length : undefined,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /**
   * Append to one text field of an existing row without the caller ever
   * holding the current body.
   *
   * The gateway API has no append endpoint, so this is a read-modify-write:
   * GET the row, concatenate here, PATCH the field back. Keeping the existing
   * text out of the caller is the whole point. The alternative is an `update`
   * in which the caller reproduces every existing character, and a character
   * altered in the carried-over region ships silently — nobody re-reads the
   * old text to check it.
   *
   * The PATCH response carries the saved row, so the write is checked rather
   * than assumed.
   */
  private async appendField(
    path: string,
    id: number,
    field: "content" | "instruction",
    addition: string,
    label: string,
    extra: Record<string, unknown> = {},
  ): Promise<GatewayResponse> {
    try {
      const { data: current } = await this.axios.get(`${path}/${id}`);
      const existing = (current as Record<string, unknown> | undefined)?.[field];
      if (existing !== undefined && existing !== null && typeof existing !== "string") {
        return { success: false, message: `${label} ${id}: ${field} is not text, so it cannot be appended to.` };
      }
      const before = (existing as string | undefined) ?? "";
      const next = joinAppended(before, addition);

      const saved = await this.patchRecord(`${path}/${id}`, compact({ [field]: next, ...extra }));
      const savedField = (saved as Record<string, unknown> | undefined)?.[field];
      if (typeof savedField === "string" && savedField !== next) {
        return {
          success: false,
          message:
            `${label} ${id}: the gateway stored a different ${field} than was sent ` +
            `(sent ${next.length} characters, stored ${savedField.length}). ` +
            `The append may be incomplete — read the record before you retry.`,
          data: saved,
        };
      }
      return {
        success: true,
        message: `${label} ${id} appended — ${field} grew from ${before.length} to ${next.length} characters`,
        data: saved,
      };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  // ── Universal knowledge: /knowledge ──────────────────────────────────────

  async listKnowledge(filters: KnowledgeListFilters = {}): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get("/knowledge", {
        params: compact({ topic: filters.topic, tag: filters.tag, search: filters.search }),
      });
      return this.pageKnowledge(data, "Knowledge", filters);
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getKnowledge(id: number): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get(`/knowledge/${id}`);
      return { success: true, message: "Knowledge loaded", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async createKnowledge(fields: KnowledgeFields): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.post("/knowledge", compact({
        topic: fields.topic,
        content: fields.content,
        tags: fields.tags,
        contentType: fields.content_type,
      }));
      return { success: true, message: "Knowledge created", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async updateKnowledge(id: number, fields: KnowledgeFields): Promise<GatewayResponse> {
    try {
      const data = await this.patchRecord(`/knowledge/${id}`, compact({
        topic: fields.topic,
        content: fields.content,
        tags: fields.tags,
        contentType: fields.content_type,
      }));
      return { success: true, message: "Knowledge updated", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  /** Add text to the end of an entry's body. See appendField. */
  async appendKnowledge(id: number, addition: string): Promise<GatewayResponse> {
    return this.appendField("/knowledge", id, "content", addition, "Knowledge");
  }

  async deleteKnowledge(id: number): Promise<GatewayResponse> {
    try {
      await this.axios.delete(`/knowledge/${id}`);
      return { success: true, message: `Knowledge ${id} deleted` };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  // ── Client knowledge: /client-knowledge ──────────────────────────────────

  async listClientKnowledge(filters: KnowledgeListFilters = {}): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get("/client-knowledge", {
        params: compact({
          site_code: filters.site_code,
          topic: filters.topic,
          tag: filters.tag,
          search: filters.search,
        }),
      });
      return this.pageKnowledge(data, "Client knowledge", filters);
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getClientKnowledge(id: number): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get(`/client-knowledge/${id}`);
      return { success: true, message: "Client knowledge loaded", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async createClientKnowledge(fields: KnowledgeFields): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.post("/client-knowledge", compact({
        siteCode: fields.site_code,
        topic: fields.topic,
        content: fields.content,
        tags: fields.tags,
        contentType: fields.content_type,
      }));
      return { success: true, message: "Client knowledge created", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async updateClientKnowledge(id: number, fields: KnowledgeFields): Promise<GatewayResponse> {
    try {
      const data = await this.patchRecord(`/client-knowledge/${id}`, compact({
        siteCode: fields.site_code,
        topic: fields.topic,
        content: fields.content,
        tags: fields.tags,
        contentType: fields.content_type,
      }));
      return { success: true, message: "Client knowledge updated", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  /** Add text to the end of a client entry's body. See appendField. */
  async appendClientKnowledge(id: number, addition: string): Promise<GatewayResponse> {
    return this.appendField("/client-knowledge", id, "content", addition, "Client knowledge");
  }

  async deleteClientKnowledge(id: number): Promise<GatewayResponse> {
    try {
      await this.axios.delete(`/client-knowledge/${id}`);
      return { success: true, message: `Client knowledge ${id} deleted` };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  // ── Self-improving instructions: /self-improving ─────────────────────────

  async listSelfImproving(filters: SelfImprovingListFilters = {}): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get("/self-improving", {
        params: compact({ tool_name: filters.tool_name, search: filters.search }),
      });
      return { success: true, message: "Self-improving instructions listed", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getSelfImproving(id: number): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get(`/self-improving/${id}`);
      return { success: true, message: "Self-improving instruction loaded", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async createSelfImproving(fields: SelfImprovingFields): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.post("/self-improving", compact({
        toolName: fields.tool_name,
        instruction: fields.instruction,
        notes: fields.notes,
      }));
      return { success: true, message: "Self-improving instruction created", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async updateSelfImproving(id: number, fields: SelfImprovingFields): Promise<GatewayResponse> {
    try {
      const data = await this.patchRecord(`/self-improving/${id}`, compact({
        instruction: fields.instruction,
        notes: fields.notes,
        changeReason: fields.change_reason,
      }));
      return { success: true, message: "Self-improving instruction updated", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  /**
   * Add text to the end of an instruction. See appendField. The gateway bumps
   * the version on any PATCH, so an append is a normal revision.
   */
  async appendSelfImproving(id: number, addition: string, changeReason?: string): Promise<GatewayResponse> {
    return this.appendField("/self-improving", id, "instruction", addition, "Self-improving instruction", {
      changeReason,
    });
  }

  async deleteSelfImproving(id: number): Promise<GatewayResponse> {
    try {
      await this.axios.delete(`/self-improving/${id}`);
      return { success: true, message: `Self-improving instruction ${id} deleted` };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  // ── Audit log: /audit (read-only) ────────────────────────────────────────

  async listAudit(filters: AuditListFilters = {}): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get("/audit", {
        params: compact({
          table_name: filters.table_name,
          tool_name: filters.tool_name,
          action: filters.action,
          limit: filters.limit,
          offset: filters.offset,
        }),
      });
      return { success: true, message: "Audit log listed", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  // ── Agent audit: /agent-audit (agent session records) ────────────────────
  // Distinct from /audit above: that one is the gateway's own change log,
  // written automatically. This one is where agents record what they did in a
  // session, so those narratives stay out of client knowledge.

  async listAgentAudit(filters: AgentAuditListFilters = {}): Promise<GatewayResponse> {
    try {
      // /agent-audit accepts limit and offset but honours neither — it always
      // returns the whole filtered set. Page here so the tool keeps its own
      // contract, and leave both off the request so a future server-side
      // implementation can't apply the offset a second time.
      const { data } = await this.axios.get("/agent-audit", {
        params: compact({
          site_code: filters.site_code,
          agent_id: filters.agent_id,
        }),
      });
      const all = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const offset = Math.max(0, filters.offset ?? 0);
      const rows =
        filters.limit === undefined
          ? all.slice(offset)
          : all.slice(offset, offset + Math.max(0, filters.limit));
      // Tell the caller when they are looking at a window rather than the lot,
      // otherwise a paged list reads as "this site only has 5 sessions".
      const range =
        rows.length === all.length ? "" : ` (${offset + 1}-${offset + rows.length} of ${all.length})`;

      // Session narratives run to thousands of tokens each. Default to a
      // summary projection so listing can never drag every taskNotes body into
      // an agent's context — that bloat is the reason this table exists.
      if (filters.full) {
        return {
          success: true,
          message: `Agent audit listed — ${rows.length} record(s), full detail${range}`,
          data: rows,
        };
      }
      return {
        success: true,
        message: `Agent audit listed — ${rows.length} record(s), summary only${range}; use action 'get' for full detail`,
        data: rows.map((r) => ({
          id: r.id,
          siteCode: r.siteCode,
          agentId: r.agentId,
          task: r.task,
          createdAt: r.createdAt,
        })),
      };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getAgentAudit(id: number): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get(`/agent-audit/${id}`);
      return { success: true, message: "Agent audit record retrieved", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async createAgentAudit(fields: AgentAuditFields): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.post("/agent-audit", compact({
        siteCode: fields.site_code,
        agentId: fields.agent_id,
        task: fields.task,
        originalRequest: fields.original_request,
        taskNotes: fields.task_notes,
        userId: fields.user_id,
      }));
      return { success: true, message: "Agent audit record created", data };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async deleteAgentAudit(id: number): Promise<GatewayResponse> {
    try {
      await this.axios.delete(`/agent-audit/${id}`);
      return { success: true, message: `Agent audit record ${id} deleted` };
    } catch (e) {
      return this.wrapError(e);
    }
  }
}
