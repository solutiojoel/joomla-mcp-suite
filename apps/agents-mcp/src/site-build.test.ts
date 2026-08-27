// Site-build pipeline tests — the deterministic stages only (validate,
// substrate, derive, verify) with a mocked Joomla executor. No LLM, no network.
// Run: npx tsx src/site-build.test.ts   (or: npm test)

import { validateDesignSpec } from "./design-spec-validator.js";
import { buildSubstrate, seedOrPlaceholder } from "./substrate.js";
import { deriveDesignYaml, deepMerge, DeriveError } from "./derive-design-yaml.js";
import { verifyBuild, extractWidths, isStillPlaceholder, visibleLength } from "./verify-build.js";
import { customHoldsClientContent, parseFingerprint, DesignSpec, SpecBlock } from "./design-spec.js";

let failures = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${label}`))
    .catch((err) => {
      failures++;
      console.error(`FAIL  ${label} — ${err.message}`);
    });
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function block(overrides: Partial<SpecBlock> = {}): SpecBlock {
  return {
    size: 100,
    particle: "contentarray",
    block_class: "mass-times-block",
    content_binding: {
      kind: "article",
      role: "mass_times",
      existing_id: 44,
      create: { title: "Mass Times", category: "Homepage Content" },
    },
    ...overrides,
  };
}

function spec(overrides: Partial<DesignSpec> = {}): DesignSpec {
  return {
    site: "https://example.com",
    site_type: "parish",
    source: "mockup.png",
    source_kind: "mockup_image",
    target_outline: "#Home",
    theme: "rt_studius",
    sections: [{ id: "utility", fingerprint: "100", blocks: [block()] }],
    ...overrides,
  };
}

/** Mock joomla executor. `articles`/`categories` are the "live site". */
function mockJoomla(opts: {
  articles?: Record<string, any>;
  categories?: any[];
  frontend?: Record<string, any>;
  inspect?: Record<string, any>;
} = {}) {
  const articles: Record<string, any> = { ...(opts.articles ?? {}) };
  const categories: any[] = [...(opts.categories ?? [])];
  const created: any[] = [];
  const updated: any[] = [];
  let nextId = 900;

  const executor = async (name: string, args: Record<string, any>) => {
    if (name === "joomla_category") {
      if (args.action === "list") return { success: true, data: categories };
      if (args.action === "create") {
        const row = { id: ++nextId, title: args.title, parent_id: args.parent_id };
        categories.push(row);
        created.push({ kind: "category", ...row });
        return { success: true, data: { id: row.id } };
      }
    }
    if (name === "joomla_article") {
      if (args.action === "list") {
        let rows = Object.entries(articles).map(([id, a]: [string, any]) => ({ id, ...a }));
        if (args.search) {
          rows = rows.filter((r: any) =>
            String(r.title).toLowerCase().includes(String(args.search).toLowerCase())
          );
        }
        if (args.category_id) {
          rows = rows.filter((r: any) => String(r.categoryId) === String(args.category_id));
        }
        return { success: true, data: rows };
      }
      if (args.action === "get") {
        const a = articles[String(args.id)];
        if (!a) throw new Error("Article not found");
        return { success: true, data: { id: args.id, ...a } };
      }
      if (args.action === "create") {
        const id = ++nextId;
        articles[String(id)] = {
          title: args.title,
          content: args.content,
          categoryId: args.categoryId,
          state: args.state,
        };
        created.push({ kind: "article", id, title: args.title, content: args.content });
        return { success: true, data: { id } };
      }
      if (args.action === "update") {
        updated.push({ id: args.id, ...args });
        return { success: true, data: { id: args.id } };
      }
    }
    if (name === "joomla_inspect_frontend") {
      const key = String(args.selector ?? "");
      if (opts.inspect && key in opts.inspect) return { success: true, data: opts.inspect[key] };
      return { success: true, data: { ruleCount: 5 } };
    }
    if (name === "joomla_get_frontend_page") {
      return { success: true, data: opts.frontend ?? { links: [], images: [], bodyText: "" } };
    }
    if (name === "joomla_workspace_write") return { success: true };
    throw new Error(`unexpected tool ${name}`);
  };

  return { executor, articles, categories, created, updated };
}

async function main() {
  // ─── helpers ───────────────────────────────────────────────────────────────
  console.log("— helpers —");

  await check("parseFingerprint parses and rejects", () => {
    assert(JSON.stringify(parseFingerprint("70|30")) === "[70,30]", "70|30");
    assert(parseFingerprint("abc") === null, "malformed rejected");
    assert(parseFingerprint(undefined) === null, "undefined rejected");
  });

  await check("deepMerge recurses objects, replaces arrays", () => {
    const out = deepMerge(
      { a: { b: 1, c: 2 }, list: [1, 2] },
      { a: { c: 9 }, list: [3] }
    ) as any;
    assert(out.a.b === 1 && out.a.c === 9, "nested merge");
    assert(JSON.stringify(out.list) === "[3]", "arrays replace wholesale");
  });

  await check("customHoldsClientContent flags embeds and prose, allows structure", () => {
    assert(customHoldsClientContent('<iframe src="x"></iframe>').violation, "iframe flagged");
    assert(customHoldsClientContent("<h2>News</h2>").violation === false, "heading allowed");
    assert(
      customHoldsClientContent(`<p>${"word ".repeat(60)}</p>`).violation,
      "long prose flagged"
    );
    assert(customHoldsClientContent("<p>a</p><p>b</p><p>c</p>").violation, "3 paragraphs flagged");
    assert(
      customHoldsClientContent('<a class="button" href="/x">Give</a>').violation === false,
      "button allowed"
    );
  });

  await check("visibleLength / isStillPlaceholder", () => {
    assert(visibleLength("<p>hello</p>") === 5, "strips markup");
    assert(isStillPlaceholder("<p>Mass Times content to be added.</p>"), "placeholder detected");
    assert(isStillPlaceholder("<p></p>"), "empty is placeholder");
    assert(
      isStillPlaceholder(`<p>${"Real parish copy. ".repeat(20)}</p>`) === false,
      "real content is not placeholder"
    );
  });

  // ─── validator: the eight invariants ──────────────────────────────────────
  console.log("— validateDesignSpec —");

  await check("a well-formed spec is valid", () => {
    const v = validateDesignSpec(spec());
    assert(v.valid, `expected valid, got: ${JSON.stringify(v.errors)}`);
    assert(v.substrate_resolved, "binding has an id, so substrate is resolved");
  });

  await check("1. content particle without a binding is rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          { id: "utility", blocks: [block({ content_binding: undefined })] },
        ],
      })
    );
    assert(!v.valid, "should be invalid");
    assert(v.errors.some((e) => e.rule === "binding-required"), "binding-required fires");
  });

  await check("3. embed in a custom particle is rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [
              block({
                particle: "custom",
                content_binding: undefined,
                html: '<iframe src="https://facebook.com/plugin"></iframe>',
              }),
            ],
          },
        ],
      })
    );
    assert(v.errors.some((e) => e.rule === "binding-violation"), "binding-violation fires");
  });

  await check("4. contentarray binding both categories and articles is rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [
              block({
                overrides: { article: { filter: { categories: "6", articles: "44" } } },
              }),
            ],
          },
        ],
      })
    );
    assert(v.errors.some((e) => e.rule === "contentarray-filter"), "filter rule fires");
  });

  await check("5. blockcontent item with an empty buttonlink is rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          {
            id: "above",
            blocks: [
              block({
                particle: "blockcontent",
                content_binding: undefined,
                subcontents: [
                  { name: "Bulletin", buttonlink: "/bulletin" },
                  { name: "Giving", buttonlink: "" },
                ],
              }),
            ],
          },
        ],
      })
    );
    assert(
      v.errors.some((e) => e.rule === "blockcontent-buttonlink"),
      "empty buttonlink rejected"
    );
  });

  await check("every fleet particle is recognised, with no spurious warning", () => {
    // blockcontent is not in CONTENT_PARTICLES (it is only content in joomla
    // mode). It must still be a KNOWN particle — a live smoke test caught it
    // warning as unknown after that split.
    for (const particle of ["contentarray", "blockcontent", "swiper", "custom", "logo", "menu"]) {
      const v = validateDesignSpec(
        spec({
          sections: [
            {
              id: "utility",
              blocks: [
                block({
                  particle,
                  content_binding: particle === "contentarray" || particle === "swiper"
                    ? { kind: "article", role: "r", existing_id: 1 }
                    : undefined,
                  subcontents: particle === "blockcontent"
                    ? [{ name: "X", buttonlink: "/x" }]
                    : undefined,
                  html: particle === "custom" ? "<h2>Hi</h2>" : undefined,
                }),
              ],
            },
          ],
        })
      );
      assert(
        !v.warnings.some((w) => w.rule === "particle-type"),
        `'${particle}' must be recognised, got: ${JSON.stringify(v.warnings)}`
      );
    }
  });

  await check("manual blockcontent needs no binding — its labels are structural", () => {
    // Requiring a binding here used to make the substrate stage create an
    // article that nothing pointed at.
    const v = validateDesignSpec(
      spec({
        sections: [
          {
            id: "above",
            blocks: [
              block({
                particle: "blockcontent",
                content_binding: undefined,
                subcontents: [{ name: "Bulletin", buttonlink: "/bulletin" }],
              }),
            ],
          },
        ],
      })
    );
    assert(v.valid, `manual blockcontent should be valid: ${JSON.stringify(v.errors)}`);
  });

  await check("blockcontent with both sources, or neither, is rejected", () => {
    const both = validateDesignSpec(
      spec({
        sections: [
          {
            id: "above",
            blocks: [
              block({
                particle: "blockcontent",
                content_binding: { kind: "category", role: "ministries", existing_id: 9 },
                subcontents: [{ name: "Bulletin", buttonlink: "/bulletin" }],
              }),
            ],
          },
        ],
      })
    );
    assert(
      both.errors.some((e) => e.rule === "blockcontent-source"),
      "both sources rejected — the compiler reads one and drops the other"
    );

    const neither = validateDesignSpec(
      spec({
        sections: [
          {
            id: "above",
            blocks: [block({ particle: "blockcontent", content_binding: undefined })],
          },
        ],
      })
    );
    assert(
      neither.errors.some((e) => e.rule === "blockcontent-source"),
      "neither source rejected — the block would render nothing"
    );
  });

  await check("6. duplicate binding roles are rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          { id: "utility", blocks: [block()] },
          { id: "extension", blocks: [block()] },
        ],
      })
    );
    assert(v.errors.some((e) => e.rule === "binding-role"), "duplicate role rejected");
  });

  await check("7. unknown section id and out-of-order sections are rejected", () => {
    const bad = validateDesignSpec(spec({ sections: [{ id: "nonsense", blocks: [block()] }] }));
    assert(bad.errors.some((e) => e.rule === "section-id"), "unknown id rejected");

    const outOfOrder = validateDesignSpec(
      spec({
        sections: [
          { id: "footer", blocks: [block()] },
          {
            id: "slideshow",
            blocks: [block({ content_binding: { kind: "article", role: "hero", existing_id: 2 } })],
          },
        ],
      })
    );
    assert(
      outOfOrder.errors.some((e) => e.rule === "section-order"),
      "out-of-stack-order rejected"
    );
  });

  await check("8. unresolved binding with no create.title is rejected", () => {
    const v = validateDesignSpec(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [block({ content_binding: { kind: "article", role: "x", existing_id: null } })],
          },
        ],
      })
    );
    assert(v.errors.some((e) => e.rule === "binding-unresolvable"), "unresolvable rejected");
    assert(!v.substrate_resolved, "substrate not resolved");
  });

  await check("fingerprint must agree with block count", () => {
    const v = validateDesignSpec(
      spec({ sections: [{ id: "utility", fingerprint: "70|30", blocks: [block()] }] })
    );
    assert(v.errors.some((e) => e.rule === "fingerprint"), "mismatch rejected");
  });

  await check("unanswered open questions warn but do not fail", () => {
    const v = validateDesignSpec(
      spec({ open_questions: [{ id: "q1", question: "which?" }] })
    );
    assert(v.valid, "still valid");
    assert(v.warnings.some((w) => w.rule === "open-questions"), "warns");
  });

  // ─── substrate ─────────────────────────────────────────────────────────────
  console.log("— buildSubstrate —");

  await check("seedOrPlaceholder never yields an empty body", () => {
    assert(seedOrPlaceholder(undefined, "Mass Times").includes("Mass Times"), "placeholder used");
    assert(seedOrPlaceholder("<p>real</p>", "X") === "<p>real</p>", "seed preserved");
  });

  await check("creates a missing article and stamps the id", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article",
                role: "mass_times",
                existing_id: null,
                create: { title: "Mass Times", category: "Homepage Content" },
              },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla();
    const report = await buildSubstrate({ executor: m.executor, spec: s });
    assert(report.errors.length === 0, `no errors: ${JSON.stringify(report.errors)}`);
    assert(report.created.some((c) => c.kind === "article"), "article created");
    const id = s.sections[0].blocks[0].content_binding!.existing_id;
    assert(typeof id === "number" && id > 0, "id stamped into the spec");
    assert(report.substrate_resolved, "substrate resolved");
  });

  await check("reuses an existing article and never touches its body", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article",
                role: "mass_times",
                existing_id: null,
                create: { title: "Mass Times", seed_content: "<p>SEED</p>" },
              },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: "<p>REAL CLIENT COPY</p>" } },
    });
    const report = await buildSubstrate({ executor: m.executor, spec: s });
    assert(report.reused.some((r) => r.id === 44), "reused id 44");
    assert(m.updated.length === 0, "no update call — existing body untouched");
    assert(m.created.length === 0, "nothing created");
    assert(s.sections[0].blocks[0].content_binding!.existing_id === 44, "id stamped");
  });

  await check("is idempotent — a second run creates nothing", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article", role: "mass_times", existing_id: null,
                create: { title: "Mass Times" },
              },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla();
    await buildSubstrate({ executor: m.executor, spec: s });
    const firstCount = m.created.length;
    await buildSubstrate({ executor: m.executor, spec: s });
    assert(m.created.length === firstCount, "second run created nothing");
  });

  await check("an ambiguous title match is an error, never a guess", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article", role: "mass_times", existing_id: null,
                create: { title: "Mass Times" },
              },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla({
      articles: {
        "44": { title: "Mass Times" },
        "45": { title: "mass times" },
      },
    });
    const report = await buildSubstrate({ executor: m.executor, spec: s });
    assert(report.errors.length === 1, "one error");
    assert(/two or more/i.test(report.errors[0].detail ?? ""), "names the ambiguity");
    assert(s.sections[0].blocks[0].content_binding!.existing_id === null, "id NOT guessed");
  });

  await check("dry_run writes nothing", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article", role: "mass_times", existing_id: null,
                create: { title: "Mass Times" },
              },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla();
    const report = await buildSubstrate({ executor: m.executor, spec: s, dry_run: true });
    assert(report.would_create.length === 1, "plan reported");
    assert(m.created.length === 0, "nothing created");
    assert(s.sections[0].blocks[0].content_binding!.existing_id === null, "no id stamped");
  });

  // ─── derive ────────────────────────────────────────────────────────────────
  console.log("— deriveDesignYaml —");

  await check("refuses to derive while a binding has no id", () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              content_binding: {
                kind: "article", role: "x", existing_id: null, create: { title: "X" },
              },
            }),
          ],
        },
      ],
    });
    let threw = false;
    try {
      deriveDesignYaml(s);
    } catch (err) {
      threw = err instanceof DeriveError && /build_content_substrate/.test((err as Error).message);
    }
    assert(threw, "layout must never precede substrate");
  });

  await check("article binding produces filter.articles, not categories", () => {
    const out = deriveDesignYaml(spec());
    const blockYaml = (out.design.sections as any[])[0].grids[0].blocks[0];
    assert(blockYaml.attributes.article.filter.articles === "44", "articles set");
    assert(blockYaml.attributes.article.filter.categories === "", "categories empty");
  });

  await check("category binding produces filter.categories and read_more", () => {
    const out = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [
              block({
                content_binding: { kind: "category", role: "news_feed", existing_id: 6 },
              }),
            ],
          },
        ],
      })
    );
    const b = (out.design.sections as any[])[0].grids[0].blocks[0];
    assert(b.attributes.article.filter.categories === "6", "categories set");
    assert(b.attributes.article.filter.articles === "", "articles empty");
    assert(b.attributes.article.display.read_more.enabled === "show", "feed gets read_more");
  });

  await check("title hidden with \"\" — never the value the compiler rejects", () => {
    const out = deriveDesignYaml(spec());
    const b = (out.design.sections as any[])[0].grids[0].blocks[0];
    assert(b.attributes.article.display.title.enabled === "", 'must be "" not "hide"');
  });

  await check("swiper defaults to non-clickable slides", () => {
    const out = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "slideshow",
            blocks: [
              block({
                particle: "swiper",
                block_class: "fullwidth-swiper",
                content_binding: { kind: "category", role: "hero_slides", existing_id: 12 },
              }),
            ],
          },
        ],
      })
    );
    const b = (out.design.top_container as any).sections[0].grids[0].blocks[0];
    assert(b.attributes.slides_linkable === "disabled", "opt-in only");
  });

  await check("blockcontent derives the mode it is actually in", () => {
    const manual = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [
              block({
                particle: "blockcontent",
                content_binding: undefined,
                subcontents: [{ name: "Bulletin", buttonlink: "/bulletin" }],
              }),
            ],
          },
        ],
      })
    );
    const mb = (manual.design.sections as any[])[0].grids[0].blocks[0];
    assert(mb.attributes.source === "manual", "manual mode");
    assert(mb.attributes.subcontents[0].buttonlink === "/bulletin", "items carried");

    // Article-sourced: an earlier version always emitted source:manual, which
    // dropped the binding and rendered an empty block.
    const sourced = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [
              block({
                particle: "blockcontent",
                content_binding: { kind: "category", role: "ministries", existing_id: 9 },
              }),
            ],
          },
        ],
      })
    );
    const sb = (sourced.design.sections as any[])[0].grids[0].blocks[0];
    assert(sb.attributes.source === "joomla", "joomla mode, not manual");
    assert(sb.attributes.article.filter.categories === "9", "binding honoured");
    assert(sb.attributes.subcontents === undefined, "no empty manual items emitted");
  });

  await check("spec overrides win over derived defaults", () => {
    const out = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "utility",
            blocks: [block({ overrides: { article: { limit: { total: "9" } } } })],
          },
        ],
      })
    );
    const b = (out.design.sections as any[])[0].grids[0].blocks[0];
    assert(b.attributes.article.limit.total === "9", "override applied");
    assert(b.attributes.article.filter.articles === "44", "binding still intact");
  });

  await check("sections route into the compiler's containers", () => {
    const out = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "slideshow",
            blocks: [block({ content_binding: { kind: "article", role: "a", existing_id: 1 } })],
          },
          {
            id: "utility",
            blocks: [block({ content_binding: { kind: "article", role: "b", existing_id: 2 } })],
          },
          {
            id: "extension",
            blocks: [block({ content_binding: { kind: "article", role: "c", existing_id: 3 } })],
          },
        ],
      })
    );
    assert(!!out.design.top_container, "slideshow → top_container");
    assert(Array.isArray(out.design.sections), "utility → sections");
    assert(Array.isArray(out.design.extra_sections), "extension → extra_sections");
    assert(out.design.preserve_base_inheritance === true, "base inheritance preserved");
    assert(out.design_yaml.includes("top_container"), "yaml renders");
  });

  await check("main_container groups emit grids, not an ignored key", () => {
    // compileSectionGroup reads `grids`. An earlier version emitted `particles`,
    // which the compiler ignored — the group compiled to an empty section with
    // no error anywhere. Pin the key the compiler actually reads.
    const out = deriveDesignYaml(
      spec({
        sections: [
          {
            id: "sidebar",
            blocks: [
              block({ size: 25, content_binding: { kind: "article", role: "side", existing_id: 5 } }),
            ],
          },
          {
            id: "mainbar",
            blocks: [
              block({ size: 75, content_binding: { kind: "category", role: "news", existing_id: 6 } }),
            ],
          },
        ],
      })
    );
    const mc = out.design.main_container as any;
    assert(mc.layout === "sidebar-main-aside", "layout named");
    for (const g of ["sidebar", "mainbar"]) {
      assert(Array.isArray(mc[g].grids), `${g} has a grids array`);
      assert(mc[g].grids[0].blocks.length === 1, `${g} carries its block`);
      assert(mc[g].particles === undefined, `${g} must not use the ignored 'particles' key`);
      assert(mc[g].section_id === g, `${g} keeps its real section id`);
      assert(mc[g].type === "section", `${g} is type section, not a generated wrapper`);
    }
    assert(mc.sidebar.size === 25 && mc.mainbar.size === 75, "group widths carried");
  });

  // ─── round-trip against the real Gantry compiler ──────────────────────────
  // The strongest check available here: a key the compiler does not read is
  // silently ignored, so unit-testing the deriver's own output cannot catch a
  // shape mismatch. Emitting `particles` instead of `grids` compiled the
  // sidebar/mainbar groups to EMPTY sections with valid:true and no error —
  // exactly the failure this round-trip catches. Skipped if gantry-mcp is not
  // resolvable (isolated checkouts), so it can never be a false red.
  console.log("— round-trip: derived YAML → design-compiler —");

  await check("derived YAML compiles, and no section comes out empty", () => {
    let compiler: any;
    try {
      compiler = require("../../gantry-mcp/lib/design-compiler.js");
    } catch {
      console.log("      (skipped — gantry-mcp compiler not resolvable here)");
      return;
    }

    const s = spec({
      sections: [
        {
          id: "slideshow",
          fingerprint: "70|30",
          blocks: [
            block({
              size: 70, particle: "swiper", block_class: "fullwidth-swiper",
              content_binding: { kind: "category", role: "hero_slides", existing_id: 12 },
            }),
            block({ size: 30 }),
          ],
        },
        {
          id: "sidebar",
          blocks: [
            block({ size: 25, content_binding: { kind: "article", role: "side", existing_id: 5 } }),
          ],
        },
        {
          id: "mainbar",
          blocks: [
            block({ size: 75, content_binding: { kind: "category", role: "news", existing_id: 6 } }),
          ],
        },
        {
          id: "extension",
          blocks: [
            block({ content_binding: { kind: "article", role: "mission", existing_id: 18 } }),
          ],
        },
      ],
    });

    const out = deriveDesignYaml(s);
    const res = compiler.compileYaml(out.design_yaml, {});
    assert(res.valid, `compiler rejected the derived YAML: ${JSON.stringify(res.errors)}`);

    const countParticles = (n: any): number => {
      if (!n) return 0;
      if (n.type === "particle") return 1;
      return (n.children || []).reduce((a: number, c: any) => a + countParticles(c), 0);
    };
    const total = res.layout.reduce((a: number, n: any) => a + countParticles(n), 0);
    assert(total >= 5, `expected every block to survive compilation, got ${total} particles`);

    // container-main specifically — the group shape that was wrong
    const cm = res.layout.find((n: any) => n.id === "container-main");
    assert(!!cm, "container-main built");
    assert(countParticles(cm) === 2, `sidebar+mainbar must carry their particles, got ${countParticles(cm)}`);

    // Base Outline inheritance must survive a homepage build
    const ids: string[] = [];
    const walk = (n: any) => { if (n?.id) ids.push(n.id); (n.children || []).forEach(walk); };
    res.layout.forEach(walk);
    for (const id of ["navigation", "footer", "copyright", "offcanvas"]) {
      assert(ids.includes(id), `Base Outline section '${id}' must be preserved`);
    }
  });

  // ─── verify ────────────────────────────────────────────────────────────────
  console.log("— verifyBuild —");

  await check("extractWidths reads the documented and flat shapes", () => {
    assert(
      JSON.stringify(extractWidths({ nodes: [{ rect: { width: 700 } }, { rect: { width: 300 } }] })) ===
        "[700,300]",
      "nested"
    );
    assert(JSON.stringify(extractWidths([{ width: 5 }])) === "[5]", "flat");
    assert(JSON.stringify(extractWidths({})) === "[]", "empty");
  });

  await check("clean build reports no defects", async () => {
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
    });
    const report = await verifyBuild({ executor: m.executor, spec: spec(), skip_frontend: true });
    assert(report.verdict === "clean", `expected clean, got ${JSON.stringify(report.defects)}`);
  });

  await check("unpublished bound article is a blocker", async () => {
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: "<p>real content here now</p>", state: "0" } },
    });
    const report = await verifyBuild({ executor: m.executor, spec: spec(), skip_frontend: true });
    assert(report.blockers >= 1, "blocker raised");
    assert(report.defects.some((d) => d.kind === "content_missing"), "content_missing");
  });

  await check("empty bound category is a blocker", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [block({ content_binding: { kind: "category", role: "news", existing_id: 6 } })],
        },
      ],
    });
    const m = mockJoomla({ articles: {} });
    const report = await verifyBuild({ executor: m.executor, spec: s, skip_frontend: true });
    assert(report.defects.some((d) => d.kind === "content_missing"), "empty category caught");
  });

  await check("copy left in a custom particle is a blocker", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              particle: "custom",
              content_binding: undefined,
              html: `<p>${"Weekend mass at four. ".repeat(20)}</p>`,
            }),
          ],
        },
      ],
    });
    const m = mockJoomla();
    const report = await verifyBuild({ executor: m.executor, spec: s, skip_frontend: true });
    assert(report.defects.some((d) => d.kind === "binding_violation"), "binding_violation");
    assert(report.blockers >= 1, "it is a blocker, not a nice-to-have");
  });

  await check("ruleCount 0 raises unstyled_block for css-author", async () => {
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
      inspect: { ".mass-times-block": { ruleCount: 0 } },
    });
    const report = await verifyBuild({ executor: m.executor, spec: spec(), page_path: "/" });
    const d = report.defects.find((x) => x.kind === "unstyled_block");
    assert(!!d, "unstyled_block raised");
    assert(d!.suggested_owner === "css-author", "routed to css-author");
    assert((d!.evidence as any).ruleCount === 0, "carries the evidence");
  });

  await check("layout drift is measured, not eyeballed", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          fingerprint: "70|30",
          blocks: [
            block({ size: 70, block_class: "a" }),
            block({
              size: 30,
              block_class: "b",
              content_binding: { kind: "article", role: "other", existing_id: 44 },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
      inspect: {
        "#g-utility > .g-container > .g-grid > .g-block": {
          nodes: [{ rect: { width: 500 } }, { rect: { width: 500 } }],
        },
      },
    });
    const report = await verifyBuild({ executor: m.executor, spec: s, page_path: "/" });
    const d = report.defects.find((x) => x.kind === "layout_drift");
    assert(!!d, "drift detected (50/50 rendered vs 70/30 spec)");
  });

  await check("a split within tolerance is not reported as drift", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          fingerprint: "70|30",
          blocks: [
            block({ size: 70, block_class: "a" }),
            block({
              size: 30,
              block_class: "b",
              content_binding: { kind: "article", role: "other", existing_id: 44 },
            }),
          ],
        },
      ],
    });
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
      inspect: {
        "#g-utility > .g-container > .g-grid > .g-block": {
          nodes: [{ rect: { width: 690 } }, { rect: { width: 310 } }],
        },
      },
    });
    const report = await verifyBuild({ executor: m.executor, spec: s, page_path: "/" });
    assert(!report.defects.some((x) => x.kind === "layout_drift"), "69/31 is within slack");
  });

  await check("empty hrefs and byline leakage are caught on the live page", async () => {
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
      frontend: {
        links: [{ href: "", text: "Ministries" }, { href: "/ok", text: "Fine" }],
        images: [{ src: "" }],
        bodyText: "Written by Administrator Hits: 42",
      },
    });
    const report = await verifyBuild({ executor: m.executor, spec: spec(), page_path: "/" });
    assert(report.defects.some((d) => d.kind === "broken_asset"), "broken_asset caught");
    assert(report.defects.some((d) => d.kind === "residual_outline"), "residual_outline caught");
  });

  await check("verify and validate agree on what counts as client content", async () => {
    // A custom particle just over the prose threshold must be caught by BOTH
    // gates. They used to use different length rules, so a spec could pass one
    // and fail the other.
    const html = `<p>${"Weekend mass at four in the afternoon. ".repeat(8)}</p>`;
    const s = spec({
      sections: [
        { id: "utility", blocks: [block({ particle: "custom", content_binding: undefined, html })] },
      ],
    });
    const v = validateDesignSpec(s);
    const m = mockJoomla();
    const report = await verifyBuild({ executor: m.executor, spec: s, skip_frontend: true });
    assert(v.errors.some((e) => e.rule === "binding-violation"), "validator catches it");
    assert(report.defects.some((d) => d.kind === "binding_violation"), "verifier catches it too");
  });

  await check("defects come back ranked, blockers first", async () => {
    const s = spec({
      sections: [
        {
          id: "utility",
          blocks: [
            block({
              particle: "custom",
              content_binding: undefined,
              html: `<p>${"Weekend mass at four. ".repeat(20)}</p>`,
            }),
            block({ block_class: "unstyled-thing" }),
          ],
        },
      ],
    });
    const m = mockJoomla({
      articles: { "44": { title: "Mass Times", content: `<p>${"Real copy. ".repeat(20)}</p>`, state: "1" } },
      inspect: { ".unstyled-thing": { ruleCount: 0 } },
    });
    const report = await verifyBuild({ executor: m.executor, spec: s, page_path: "/" });
    assert(report.defects.length >= 2, "several defects");
    assert(report.defects[0].severity === "blocker", "blocker sorts first");
  });

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
