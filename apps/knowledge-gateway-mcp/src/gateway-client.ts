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

/** Drop undefined values so we never send empty query params or body keys. */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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

  // ── Universal knowledge: /knowledge ──────────────────────────────────────

  async listKnowledge(filters: KnowledgeListFilters = {}): Promise<GatewayResponse> {
    try {
      const { data } = await this.axios.get("/knowledge", {
        params: compact({ topic: filters.topic, tag: filters.tag, search: filters.search }),
      });
      return { success: true, message: "Knowledge listed", data };
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
      const { data } = await this.axios.patch(`/knowledge/${id}`, compact({
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
      return { success: true, message: "Client knowledge listed", data };
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
      const { data } = await this.axios.patch(`/client-knowledge/${id}`, compact({
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
      const { data } = await this.axios.patch(`/self-improving/${id}`, compact({
        instruction: fields.instruction,
        notes: fields.notes,
        changeReason: fields.change_reason,
      }));
      return { success: true, message: "Self-improving instruction updated", data };
    } catch (e) {
      return this.wrapError(e);
    }
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
}
