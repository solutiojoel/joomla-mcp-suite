import { DesignSpec, ContentBinding, collectBindings, FLEET_CONTENT } from "./design-spec.js";
import {
  Executor,
  SubstrateOptions,
  SubstrateReport,
  callSafe,
  rows,
  toId,
  titleEq,
  seedOrPlaceholder,
} from "./substrate-util.js";

/**
 * The resolution core of Phase 2. Split from the types/helpers so the scoping
 * rules read in one piece — they are the part that protects a live site.
 */
export async function buildSubstrate(opts: SubstrateOptions): Promise<SubstrateReport> {
  const { executor, spec, dry_run = false } = opts;
  const isRedesign = spec.build_type === "redesign";

  const report: SubstrateReport = {
    build_type: spec.build_type ?? "new",
    created: [],
    would_create: [],
    reused: [],
    copied: [],
    errors: [],
    substrate_resolved: false,
  };

  // Read the category tree once — scope decisions need the whole picture.
  const allCats = rows(await callSafe(executor, "joomla_category", { action: "list", limit: 500 }));

  // ── establish the scope ──────────────────────────────────────────────────
  // On a redesign this is the ONLY set of categories a lookup may match inside.
  // Getting this wrong is how a new homepage ends up bound to live content.
  let redesignRootId: number | undefined;
  const scope = new Set<number>();

  if (isRedesign) {
    const rootTitle = spec.content_scope?.redesign_root ?? "Redesign";
    const existing = allCats.filter((c) => titleEq(c.title, rootTitle));
    if (existing.length > 1) {
      report.errors.push({
        role: "(scope)",
        kind: "category",
        title: rootTitle,
        outcome: "failed",
        detail: `two or more categories are titled '${rootTitle}' — resolve by hand and set content_scope.redesign_root_id`,
      });
      return report;
    }
    redesignRootId = toId(existing[0]?.id) ?? toId(spec.content_scope?.redesign_root_id);

    if (!redesignRootId && !dry_run) {
      const res = await callSafe(executor, "joomla_category", { action: "create", title: rootTitle });
      redesignRootId = toId(res?.data?.id ?? res?.data?.categoryId);
      if (!redesignRootId) {
        report.errors.push({
          role: "(scope)",
          kind: "category",
          title: rootTitle,
          outcome: "failed",
          detail: `could not create the redesign parent category: ${res.message ?? "no id returned"}`,
        });
        return report;
      }
      report.created.push({
        role: "(scope)",
        kind: "category",
        title: rootTitle,
        id: redesignRootId,
        outcome: "created",
      });
    }

    if (redesignRootId) {
      scope.add(redesignRootId);
      const rootName = String(existing[0]?.title ?? rootTitle);
      for (const c of allCats) {
        if (titleEq(c.parent, rootName)) {
          const cid = toId(c.id);
          if (cid) scope.add(cid);
        }
      }
    }
    report.redesign_root_id = redesignRootId ?? null;
  }

  /** Is this category inside the build's scope? On a new build, everything is. */
  const catInScope = (id: number | undefined) =>
    !isRedesign || (id !== undefined && scope.has(id));

  const categoryIds = new Map<string, number>();

  /** Find a category by title, honouring the scope. A redesign only ever sees
   *  its own subtree, so a live category sharing a title is invisible here. */
  const findCategory = (title: string): number | undefined | "ambiguous" => {
    const key = title.trim().toLowerCase();
    if (categoryIds.has(key)) return categoryIds.get(key);
    const hits = allCats
      .filter((c) => titleEq(c.title, title))
      .filter((c) => catInScope(toId(c.id)));
    if (hits.length > 1) return "ambiguous";
    const id = toId(hits[0]?.id);
    if (id) categoryIds.set(key, id);
    return id;
  };

  const ensureCategory = async (
    title: string,
    parentTitle: string | undefined,
    role: string
  ): Promise<number | undefined> => {
    const found = findCategory(title);
    if (found === "ambiguous") {
      report.errors.push({
        role,
        kind: "category",
        title,
        outcome: "failed",
        detail: `two or more categories titled '${title}' inside the build scope — resolve by hand and set existing_id`,
      });
      return undefined;
    }
    if (found) {
      report.reused.push({ role, kind: "category", title, id: found, outcome: "reused" });
      return found;
    }

    // On a redesign every category hangs off the redesign root, so the spec's
    // own `parent` only ever applies within that subtree.
    let parentId: number | undefined = isRedesign ? redesignRootId : undefined;
    if (parentTitle) {
      const p = findCategory(parentTitle);
      if (p === "ambiguous") {
        report.errors.push({
          role,
          kind: "category",
          title,
          outcome: "failed",
          detail: `parent category '${parentTitle}' is ambiguous inside the build scope`,
        });
        return undefined;
      }
      if (p) {
        parentId = p;
      } else if (!dry_run) {
        const args: Record<string, any> = { action: "create", title: parentTitle };
        if (isRedesign && redesignRootId) args.parentId = String(redesignRootId);
        const pRes = await callSafe(executor, "joomla_category", args);
        const pid = toId(pRes?.data?.id ?? pRes?.data?.categoryId);
        if (pid) {
          parentId = pid;
          scope.add(pid);
          categoryIds.set(parentTitle.trim().toLowerCase(), pid);
          report.created.push({
            role: `${role}__parent`,
            kind: "category",
            title: parentTitle,
            id: pid,
            outcome: "created",
          });
        }
      }
    }

    if (dry_run) {
      report.would_create.push({ role, kind: "category", title, outcome: "would_create" });
      return undefined;
    }

    const args: Record<string, any> = { action: "create", title };
    if (parentId) args.parentId = String(parentId);
    const res = await callSafe(executor, "joomla_category", args);
    const id = toId(res?.data?.id ?? res?.data?.categoryId);
    if (!id) {
      report.errors.push({
        role,
        kind: "category",
        title,
        outcome: "failed",
        detail: res.message || "create returned no id",
      });
      return undefined;
    }
    scope.add(id);
    categoryIds.set(title.trim().toLowerCase(), id);
    report.created.push({ role, kind: "category", title, id, outcome: "created" });
    return id;
  };

  const ensureArticle = async (binding: ContentBinding): Promise<number | undefined> => {
    const create = binding.create;
    const role = binding.role;
    // Prefer the fleet's canonical title for a known role — far more reliable
    // than whatever free text the interpreter happened to choose.
    const fleet = FLEET_CONTENT[role];
    const title = create?.title ?? fleet?.title ?? "";
    const targetCategory = create?.category ?? fleet?.category;

    const found = rows(await callSafe(executor, "joomla_article", { action: "list", search: title }));
    const exact = found.filter((r) => titleEq(r.title, title));
    const inScope = exact.filter((r) => catInScope(toId(r.categoryId)));

    if (inScope.length > 1) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: `two or more articles titled '${title}' inside the build scope (ids ${inScope
          .map((m) => m.id)
          .join(", ")}) — resolve by hand and set existing_id`,
      });
      return undefined;
    }
    if (inScope.length === 1) {
      // Never touch the body: it holds real client work.
      const id = toId(inScope[0].id)!;
      report.reused.push({ role, kind: "article", title, id, outcome: "reused" });
      return id;
    }

    // Resolve the destination category before either write path.
    let categoryId: number | undefined;
    if (targetCategory) {
      categoryId = await ensureCategory(targetCategory, create?.parent, `${role}__category`);
    } else if (isRedesign) {
      categoryId = redesignRootId;
    }
    if (!categoryId && !dry_run && (targetCategory || isRedesign)) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: `could not resolve the destination category for '${title}'`,
      });
      return undefined;
    }

    // ── redesign: a live match is COPIED, never bound to ────────────────────
    const live = exact.find((r) => !catInScope(toId(r.categoryId)));
    if (isRedesign && live) {
      const liveId = toId(live.id)!;
      if (dry_run) {
        report.would_create.push({
          role,
          kind: "article",
          title,
          outcome: "would_copy",
          copied_from: liveId,
          detail: `would copy live article ${liveId} into the redesign scope; the live row is not modified`,
        });
        return undefined;
      }
      // Read the live body, then write a NEW row. The source is never updated.
      const src = await callSafe(executor, "joomla_article", { action: "get", id: String(liveId) });
      const body = src?.data?.content ?? src?.data?.introtext ?? "";
      const res = await callSafe(executor, "joomla_article", {
        action: "create",
        title,
        categoryId: String(categoryId),
        content: body || seedOrPlaceholder(create?.seed_content, title),
        state: "1",
      });
      const id = toId(res?.data?.id ?? res?.data?.articleId);
      if (!id) {
        report.errors.push({
          role,
          kind: "article",
          title,
          outcome: "failed",
          detail: `copy failed: ${res.message ?? "create returned no id"}`,
        });
        return undefined;
      }
      report.copied.push({
        role,
        kind: "article",
        title,
        id,
        outcome: "copied",
        copied_from: liveId,
        detail: `duplicated from live article ${liveId}; the live row was read only`,
      });
      return id;
    }

    // ── new build: a match anywhere is fine to reuse ────────────────────────
    if (!isRedesign && exact.length === 1) {
      const id = toId(exact[0].id)!;
      report.reused.push({ role, kind: "article", title, id, outcome: "reused" });
      return id;
    }
    if (!isRedesign && exact.length > 1) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: `two or more articles titled '${title}' (ids ${exact
          .map((m) => m.id)
          .join(", ")}) — resolve by hand and set existing_id`,
      });
      return undefined;
    }

    if (dry_run) {
      report.would_create.push({ role, kind: "article", title, outcome: "would_create" });
      return undefined;
    }

    const res = await callSafe(executor, "joomla_article", {
      action: "create",
      title,
      categoryId: categoryId ? String(categoryId) : undefined,
      content: seedOrPlaceholder(create?.seed_content, title),
      state: "1",
    });
    const id = toId(res?.data?.id ?? res?.data?.articleId);
    if (!id) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: res.message || "create returned no id",
      });
      return undefined;
    }
    report.created.push({ role, kind: "article", title, id, outcome: "created" });
    return id;
  };

  // ── walk the spec in section order ───────────────────────────────────────
  for (const { binding } of collectBindings(spec)) {
    if (binding.existing_id) continue; // already resolved — leave it alone

    const fleet = FLEET_CONTENT[binding.role];
    const create = binding.create;
    if (!create?.title && !fleet) {
      report.errors.push({
        role: binding.role,
        kind: binding.kind,
        title: "(none)",
        outcome: "failed",
        detail: "binding has neither existing_id, create.title, nor a known fleet role",
      });
      continue;
    }

    const id =
      binding.kind === "category"
        ? await ensureCategory(create?.title ?? fleet!.title, create?.parent, binding.role)
        : await ensureArticle(binding);

    if (id) {
      binding.existing_id = id;
      binding.created_by_build =
        report.created.some((c) => c.role === binding.role && c.id === id) ||
        report.copied.some((c) => c.role === binding.role && c.id === id);
    }
  }

  const all = collectBindings(spec);
  report.substrate_resolved = all.length > 0 && all.every((b) => !!b.binding.existing_id);
  if (isRedesign) {
    spec.content_scope = { ...(spec.content_scope ?? {}), redesign_root_id: redesignRootId ?? null };
  }
  return report;
}
