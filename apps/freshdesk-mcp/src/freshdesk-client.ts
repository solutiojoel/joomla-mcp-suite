import axiosLib, { AxiosInstance } from "axios";

export interface FreshdeskResponse {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface FreshdeskConfig {
  domain: string;
  apiKey: string;
}

export interface FreshdeskAttachment {
  id: number;
  name: string;
  content_type: string;
  size: number;
  attachment_url: string;
}

export interface FreshdeskTicket {
  id: number;
  subject: string;
  description_text: string;
  description: string;
  status: number;
  status_label: string;
  priority: number;
  priority_label: string;
  tags: string[];
  requester_id: number;
  company_id: number | null;
  site_code: string | null;
  site_url: string | null;
  attachments: FreshdeskAttachment[];
  inline_images: string[];
  created_at: string;
  updated_at: string;
}

export interface FreshdeskContact {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  mobile: string | null;
  company_id: number | null;
  other_companies: Array<{ company_id: number; view_all_tickets: boolean }>;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FreshdeskCompany {
  id: number;
  name: string;
  domains: string[];
  custom_fields: Record<string, unknown>;
  site_code: string;
  site_url: string;
  created_at: string;
  updated_at: string;
}

export interface FreshdeskConversation {
  id: number;
  ticket_id: number;
  type: "reply" | "note";
  body_text: string;
  author_name: string;
  from_email: string | null;
  private: boolean;
  attachments: FreshdeskAttachment[];
  inline_images: string[];
  created_at: string;
  updated_at: string;
}

export interface FreshdeskNoteResult {
  id: number;
  ticket_id: number;
  body: string;
  private: boolean;
  created_at: string;
}

export interface FreshdeskUpdateFields {
  status?: number;
  priority?: number;
  tags?: string[];
}

const STATUS_MAP: Record<number, string> = {
  2: "Open",
  3: "Pending",
  4: "Resolved",
  5: "Closed",
};

const PRIORITY_MAP: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Urgent",
};

export function toSiteCode(companyName: string): string {
  return companyName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function extractInlineImages(html: string | undefined): string[] {
  if (!html) return [];
  const urls: string[] = [];
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Skip data: URIs — they're inline base64 and would bloat the result.
    if (/^https?:\/\//i.test(m[1])) urls.push(m[1]);
  }
  return Array.from(new Set(urls));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface AttachmentRaw {
  id: number;
  name: string;
  content_type: string;
  size: number;
  attachment_url: string;
}

function mapAttachments(raw: AttachmentRaw[] | undefined): FreshdeskAttachment[] {
  return (raw ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    content_type: a.content_type,
    size: a.size,
    attachment_url: a.attachment_url,
  }));
}

interface ConvRaw {
  id: number;
  source: number;
  body_text: string;
  body: string;
  from_email: string | null;
  user_id: number;
  private: boolean;
  attachments?: AttachmentRaw[];
  created_at: string;
  updated_at: string;
}

interface TicketRaw {
  id: number;
  subject: string;
  description_text: string;
  description: string;
  status: number;
  priority: number;
  tags: string[];
  requester_id: number;
  company_id: number | null;
  attachments?: AttachmentRaw[];
  created_at: string;
  updated_at: string;
}

interface ContactRaw {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  mobile: string | null;
  company_id: number | null;
  other_companies: Array<{ company_id: number; view_all_tickets: boolean }>;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface CompanyRaw {
  id: number;
  name: string;
  domains: string[];
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Freshdesk renders note bodies as raw HTML and does not convert markdown — a note written
// in markdown (blank-line paragraphs, "- "/"1. " lists) collapses into one run-on paragraph.
// If the body has no HTML block tags at all, treat it as plain text/markdown and convert the
// common subset to real HTML before sending. A body that already contains HTML tags is
// passed through unchanged, so a caller that already writes correct HTML is never touched.
function escapeInlineMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

// Every note Shannon writes carries this attribution line. It lives here, next to the
// converter, because the order of the two is load-bearing: addNote converts the caller's
// body FIRST and prepends the attribution after. A caller that prepends it itself hands
// markdownToHtmlIfNeeded a body that already opens with "<p", so the HTML check below
// passes and the caller's markdown ships to Freshdesk verbatim — literal "**bold**" and
// "- " bullets in the note. Do not prepend this at a call site.
export const NOTE_ATTRIBUTION = "<p>— Shannon (AI Assistant)</p>";

export function markdownToHtmlIfNeeded(body: string): string {
  if (/<(p|ul|ol|li|div|br|strong|em|b|i|h[1-6])\b/i.test(body)) return body;

  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 0) return body;

  const html = blocks.map((block) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const isUnordered = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
    const isOrdered = lines.length > 0 && lines.every((l) => /^\d+\.\s+/.test(l));
    if (isUnordered) {
      return `<ul>${lines.map((l) => `<li>${escapeInlineMarkdown(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    if (isOrdered) {
      return `<ol>${lines.map((l) => `<li>${escapeInlineMarkdown(l.replace(/^\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
    }
    return `<p>${escapeInlineMarkdown(lines.join(" "))}</p>`;
  });

  return html.join("\n");
}

export class FreshdeskClient {
  private readonly axios: AxiosInstance;

  constructor(config: FreshdeskConfig) {
    const token = Buffer.from(`${config.apiKey}:X`).toString("base64");
    this.axios = axiosLib.create({
      baseURL: `https://${config.domain}/api/v2`,
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
  }

  private wrapError(error: unknown): FreshdeskResponse {
    if (axiosLib.isAxiosError(error)) {
      const status = error.response?.status;
      const body = error.response?.data as Record<string, unknown> | undefined;
      const msg =
        (body?.description as string) ||
        (body?.message as string) ||
        error.message;
      return {
        success: false,
        message: `Freshdesk API error ${status ?? "unknown"}: ${msg}`,
      };
    }
    return { success: false, message: `Unexpected error: ${String(error)}` };
  }

  async getTicket(ticketId: number): Promise<FreshdeskResponse> {
    try {
      const { data } = await this.axios.get<TicketRaw>(`/tickets/${ticketId}`);
      let siteCode: string | null = null;
      let siteUrl: string | null = null;
      if (data.company_id) {
        try {
          const { data: company } = await this.axios.get<CompanyRaw>(`/companies/${data.company_id}`);
          siteCode = toSiteCode(company.name);
          siteUrl = `https://${siteCode}.solutiosoftware.com`;
        } catch {
          // company lookup is best-effort; leave nulls
        }
      }
      const ticket: FreshdeskTicket = {
        id: data.id,
        subject: data.subject,
        description_text: data.description_text,
        description: data.description,
        status: data.status,
        status_label: STATUS_MAP[data.status] ?? String(data.status),
        priority: data.priority,
        priority_label: PRIORITY_MAP[data.priority] ?? String(data.priority),
        tags: data.tags ?? [],
        requester_id: data.requester_id,
        company_id: data.company_id ?? null,
        site_code: siteCode,
        site_url: siteUrl,
        attachments: mapAttachments(data.attachments),
        inline_images: extractInlineImages(data.description),
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
      return { success: true, message: "Ticket loaded", data: ticket };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getContact(contactId: number): Promise<FreshdeskResponse> {
    try {
      const { data } = await this.axios.get<ContactRaw>(
        `/contacts/${contactId}`
      );
      const contact: FreshdeskContact = {
        id: data.id,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        mobile: data.mobile ?? null,
        company_id: data.company_id ?? null,
        other_companies: data.other_companies ?? [],
        custom_fields: data.custom_fields ?? {},
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
      return { success: true, message: "Contact loaded", data: contact };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getCompany(companyId: number): Promise<FreshdeskResponse> {
    try {
      const { data } = await this.axios.get<CompanyRaw>(
        `/companies/${companyId}`
      );
      const siteCode = toSiteCode(data.name);
      const company: FreshdeskCompany = {
        id: data.id,
        name: data.name,
        domains: data.domains ?? [],
        custom_fields: data.custom_fields ?? {},
        site_code: siteCode,
        site_url: `https://${siteCode}.solutiosoftware.com`,
        created_at: data.created_at,
        updated_at: data.updated_at,
      };
      return { success: true, message: "Company loaded", data: company };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async getConversations(ticketId: number): Promise<FreshdeskResponse> {
    try {
      const { data } = await this.axios.get<ConvRaw[]>(
        `/tickets/${ticketId}/conversations`
      );
      const conversations: FreshdeskConversation[] = data.map((c) => ({
        id: c.id,
        ticket_id: ticketId,
        type: c.source === 2 ? "note" : "reply",
        body_text: c.body_text ? c.body_text.trim() : stripHtml(c.body ?? ""),
        author_name: c.from_email ?? `Agent #${c.user_id}`,
        from_email: c.from_email ?? null,
        private: c.private ?? false,
        attachments: mapAttachments(c.attachments),
        inline_images: extractInlineImages(c.body),
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));
      return {
        success: true,
        message: `${conversations.length} conversation(s) loaded`,
        data: conversations,
      };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async addNote(
    ticketId: number,
    body: string,
    isPrivate = true
  ): Promise<FreshdeskResponse> {
    try {
      const htmlBody = `${NOTE_ATTRIBUTION}${markdownToHtmlIfNeeded(body)}`;
      const { data } = await this.axios.post(
        `/tickets/${ticketId}/notes`,
        { body: htmlBody, private: isPrivate, notify_emails: [] }
      );
      const note: FreshdeskNoteResult = {
        id: data.id,
        ticket_id: ticketId,
        body: data.body,
        private: data.private,
        created_at: data.created_at,
      };
      return { success: true, message: "Note added", data: note };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async listTickets(options: {
    status?: "open" | "pending" | "waiting" | "resolved" | "closed" | "unresolved" | "all";
    company_id?: number;
    page?: number;
  }): Promise<FreshdeskResponse> {
    try {
      const { status = "unresolved", company_id, page = 1 } = options;

      // Custom statuses: 6=Waiting on Customer, 7=Waiting on Third Party
      const STATUS_FILTER_MAP: Record<string, number[]> = {
        open: [2],
        pending: [3],
        waiting: [6, 7],
        resolved: [4],
        closed: [5],
        unresolved: [2, 3, 6, 7],
        all: [2, 3, 4, 5, 6, 7],
      };

      const statuses = STATUS_FILTER_MAP[status] ?? [2, 3];
      const statusPart =
        statuses.length === 1
          ? `status:${statuses[0]}`
          : `(${statuses.map((s) => `status:${s}`).join(" OR ")})`;

      const parts = [statusPart];
      if (company_id) parts.push(`company_id:${company_id}`);
      const query = parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`;

      const { data } = await this.axios.get<{ total: number; results: TicketRaw[] }>(
        "/search/tickets",
        { params: { query: `"${query}"`, page } }
      );

      const tickets = (data.results ?? []).map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        status_label: STATUS_MAP[t.status] ?? String(t.status),
        priority: t.priority,
        priority_label: PRIORITY_MAP[t.priority] ?? String(t.priority),
        tags: t.tags ?? [],
        requester_id: t.requester_id,
        company_id: t.company_id ?? null,
        created_at: t.created_at,
        updated_at: t.updated_at,
      }));

      return {
        success: true,
        message: `${data.total} ticket(s) found (page ${page})`,
        data: { total: data.total, page, tickets },
      };
    } catch (e) {
      return this.wrapError(e);
    }
  }

  async updateTicket(
    ticketId: number,
    fields: FreshdeskUpdateFields
  ): Promise<FreshdeskResponse> {
    try {
      const payload: Record<string, unknown> = {};
      if (fields.status !== undefined) payload.status = fields.status;
      if (fields.priority !== undefined) payload.priority = fields.priority;
      if (fields.tags !== undefined) payload.tags = fields.tags;

      if (Object.keys(payload).length === 0) {
        return {
          success: false,
          message: "No fields to update were provided.",
        };
      }

      const { data } = await this.axios.put(`/tickets/${ticketId}`, payload);
      return {
        success: true,
        message: `Ticket ${ticketId} updated`,
        data: {
          id: data.id,
          status: data.status,
          status_label: STATUS_MAP[data.status] ?? String(data.status),
          priority: data.priority,
          priority_label: PRIORITY_MAP[data.priority] ?? String(data.priority),
          tags: data.tags,
          updated_at: data.updated_at,
        },
      };
    } catch (e) {
      return this.wrapError(e);
    }
  }
}
