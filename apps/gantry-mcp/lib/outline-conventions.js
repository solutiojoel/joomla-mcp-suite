'use strict';

const OUTLINE_CONVENTIONS = `
# Solutio Gantry 5 Outline and Subsite Conventions

Use this reference before creating, duplicating, inheriting, cloning, or assigning
Gantry 5 outlines on Solutio Joomla sites. The canonical live model is
https://agent7.forge.solutiosoftware.com/.

Agent7 canonical outline examples:
- default: Base Outline
- 32: #Outline
- 33: #Home
- 34: #Grid
- 35: #Sponsors
- 69: #School Outline
- 70: #School Grid
- 71: #School Sponsors
- 72: #School Home

## Primary Site Outline Set

Primary parish/church sites use these outlines:
- Base Outline
- #Outline
- #Home
- #Grid
- #Sponsors

Base Outline:
- The design root for the primary site.
- Page Settings are maintained here because most other primary outlines inherit them.
- It cannot be assigned directly to pages.
- Treat color/font/custom-content setup here as site-wide for the primary site.

#Outline:
- The assignable subpage outline for most single menu items.
- Layout: every section/container inherits from Base Outline.
- Page Settings: fully inherit from Base Outline.
- Purpose: a clean assignable clone of Base Outline behavior.

#Home:
- Layout: Navigation, Bottom, Footer, Copyright, and Offcanvas Section inherit
  from Base Outline.
- Layout: all other sections are custom homepage design sections.
- Top section must include System Messages, Alert contentarray, and Pop Up custom particle.
- Page Settings: inherit from Base Outline except Body Classes.
- Body Classes: gantry site-home withmaxwidth.
- Body Classes must not include site-sub.

#Grid:
- Layout: everything inherits from Base Outline except Utility and Main.
- Utility: contains the Top Ads module instance/position.
- Main Container: Main uses the Base Outline particle structure, but Content Bottom A
  block CSS ID is grid-addpic.
- Aside is empty and 5% width.
- Sidebar may inherit from Base Outline and should be 5% width.
- Main should be 90% width.
- Page Settings: inherit from Base Outline except Body Id.
- Body Id: site-grid.

#Sponsors:
- Layout: all sections inherit from Base Outline except Aside.
- Aside: remove or disable the Side Menu particle.
- Aside: keep only the SideBar A module position particle.
- Page Settings: fully inherit from Base Outline.

## Subsite Outline Set

Subsites are separate design families inside one Joomla install, such as a school,
cemetery, secondary parish, or any area needing independent colors, fonts, CSS, and
navigation inheritance.

For a school subsite, use:
- #School Outline
- #School Home
- #School Grid
- #School Sponsors

For a non-school subsite, replace School with the subsite name:
- #Cemetery Outline
- #Cemetery Home
- #Cemetery Grid
- #Cemetery Sponsors

Critical rule:
- A subsite outline family must not inherit layout or Page Settings from the primary
  Base Outline.
- The subsite #Outline takes the role that Base Outline has for the primary site.
- The subsite #Outline must have all Layout screen sections locally cloned before
  #<Subsite> Home, #<Subsite> Grid, or #<Subsite> Sponsors inherit from it.
- Subsite colors, fonts, and Custom Content live on the subsite #Outline Page Settings.
- Subsite child outlines do not use entangled/inherited Page Settings. They get local,
  checked Page Settings copied from #<Subsite> Outline, then only the documented Body
  Classes or Body Id tweak is applied.

## Page Settings Copy Semantics

Do not use Gantry's entangled Page Settings behavior for subsite child outlines.
For #<Subsite> Home, #<Subsite> Grid, and #<Subsite> Sponsors:
- Copy Page Settings from #<Subsite> Outline as local target values.
- Force the target Page Settings origin/entanglement field blank.
- Head Properties must match #<Subsite> Outline.
- Assets must match #<Subsite> Outline.
- Font Awesome settings should match #<Subsite> Outline.
- Body Attributes should match #<Subsite> Outline except for the documented target
  differences below.

Use gantry_page_copy_from for this. It copies all normal page[*] values except
page[current_outline], clears page[origin] by default when present, and then applies
the chosen preset/body overrides.

## Gantry Clone Semantics

When these instructions say to clone a section in the Layout screen, use the
Inheritance field's Clone option with all three clone checkboxes enabled:
- Section Attributes
- Block Attributes
- Particles within Section

In tool terms, use gantry_layout_sections_clone_from. Do not use
gantry_layout_section_clone for this workflow; that older tool only clears an
inheritance flag and does not copy source section/block/particle content.

For the subsite #Outline specifically, prefer gantry_layout_clone_all_from instead
of cloning sections one by one. It copies the entire Base Outline layout into the
subsite #Outline and clears inheritance on every copied container, section, grid,
block, and particle. This prevents the common failure where the new subsite
#Outline still says "Inheriting from Base Outline" across the Layout tab.

Standard Layout screen node ids to consider for full subsite #Outline cloning:
- container-top
- top
- navigation
- slideshow
- header
- above
- feature
- showcase
- utility
- container-main
- sidebar
- mainbar
- aside
- expanded
- extension
- bottom
- container-footer
- footer
- copyright
- offcanvas

## Creating a Subsite Family

1. Create the subsite #Outline:
- Duplicate the primary #Outline and rename it #<Subsite> Outline.
- Before any other subsite outline inherits from it, clone the entire Base Outline
  layout into #<Subsite> Outline as local content using gantry_layout_clone_all_from.
- This full clone must preserve the Base Outline layout content but clear all
  inherited/locked state on every copied node.
- If doing it manually through Gantry's Clone UI, every section clone must include
  Section Attributes, Block Attributes, and Particles within Section.
- After this step, #<Subsite> Outline must own local layout sections instead of
  inheriting from Base Outline.
- In Page Settings, enable every Properties override checkbox so the subsite #Outline
  no longer inherits Base Outline Page Settings.
- In tools, use gantry_page_copy_from from Base Outline (or the intended source
  outline) to #<Subsite> Outline with forceLocal true, then edit the subsite values.
- Update Page Settings as a fresh site: Custom Content, colors, fonts, favicon/assets,
  meta, Body Classes, and any subsite-specific settings.
- Standard subpage Body Classes should include gantry site-sub withmaxwidth unless
  the site has a documented exception.

2. Create the subsite Home outline:
- Duplicate #Home and rename it #<Subsite> Home.
- Layout: Navigation, Bottom, Footer, Copyright, and Offcanvas Section inherit from
  #<Subsite> Outline.
- Layout: every other section is cloned from #Home using Section Attributes,
  Block Attributes, and Particles within Section. These sections must not inherit
  from Base Outline.
- In practice, inherit these from #<Subsite> Outline: navigation, bottom, footer,
  copyright, offcanvas.
- Clone all remaining #Home sections/containers that contain homepage design:
  top, slideshow, header, above, feature, showcase, utility, container-main,
  sidebar, mainbar, aside, expanded, extension, and any non-shared containers
  needed to preserve the layout.
- Page Settings: copy #<Subsite> Outline Page Settings.
- Head Properties and Assets must match #<Subsite> Outline.
- Do not entangle/inherit Page Settings.
- Body Classes: gantry site-home withmaxwidth.
- Body Classes must not include site-sub.

3. Create the subsite Grid outline:
- Duplicate #Grid and rename it #<Subsite> Grid.
- Layout: inherit from #<Subsite> Outline except the same Utility and Main sections
  that are custom on #Grid.
- Utility and Main should be cloned from #Grid using Section Attributes,
  Block Attributes, and Particles within Section. They must be identical to #Grid
  behavior, but not inherited from Base Outline.
- In practice, inherit shared sections from #<Subsite> Outline and clone utility
  plus the Main section/mainbar structure from #Grid.
- Main Content Bottom A block CSS ID remains grid-addpic.
- Aside is empty at 5%, Sidebar is 5%, Main is 90%.
- Page Settings: copy #<Subsite> Outline Page Settings.
- Head Properties and Assets must match #<Subsite> Outline.
- Do not entangle/inherit Page Settings.
- Body Id: site-grid.

4. Create the subsite Sponsors outline:
- Duplicate #Sponsors and rename it #<Subsite> Sponsors.
- Layout: inherit every section from #<Subsite> Outline except Aside.
- Aside is cloned from #Sponsors using Section Attributes, Block Attributes, and
  Particles within Section. It matches #Sponsors: Side Menu removed/disabled;
  SideBar A module position kept.
- Page Settings: exact copy of #<Subsite> Outline Page Settings.
- Head Properties and Assets must match #<Subsite> Outline.
- Do not entangle/inherit Page Settings.

## Gantry Tool Workflow

Before changing outlines:
- Run gantry_outlines_list and resolve titles to ids.
- Use gantry_layout_tree or gantry_layout_sections to inspect source and target outlines.
- Use gantry_page_settings_breakdown to inspect Page Settings on source outlines.
- Dry-run any layout mutation when a dryRun option exists.

Useful low-level tools:
- gantry_outlines_duplicate: create each new outline from the matching source outline.
- gantry_layout_clone_all_from: clone the entire Base Outline layout locally into
  #<Subsite> Outline and clear all inherited state. Use this before any child
  subsite outline inherits from #<Subsite> Outline.
- gantry_layout_section_inherit: point inherited sections to the correct parent outline.
- gantry_layout_sections_clone_from: copy source section attributes, block attributes,
  and particles into the target; use this for the subsite clone process.
- gantry_layout_section_clone: only clears inheritance on an already-local node; do not
  rely on it for the subsite clone process.
- gantry_layout_copy_from: copy an entire layout when a target must be reset to a source.
- gantry_page_edit or gantry_page_body_edit: set Body Classes and Body Id.
- gantry_page_copy_from: copy subsite #Outline Page Settings locally to child outlines
  without entangling, then apply Home/Grid/Sponsors body tweaks.
- gantry_page_head_edit: update Custom Content and managed site defaults.
- gantry_page_settings_breakdown: verify Page Settings after copying/editing.

Do not delete and recreate outlines to fix mistakes. Duplicate, edit, copy, or undo so
existing references and assignments stay intact.

## Verification Checklist

Primary family:
- Base Outline owns primary Page Settings.
- #Outline layout and Page Settings inherit from Base Outline.
- #Home body class is gantry site-home withmaxwidth.
- #Home inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from Base Outline.
- #Grid Body Id is site-grid and Main/Sidebar/Aside widths are 90/5/5.
- #Grid Content Bottom A block CSS ID is grid-addpic.
- #Sponsors Aside has no Side Menu and keeps SideBar A module position.

Subsite family:
- #<Subsite> Outline does not inherit Page Settings from Base Outline.
- #<Subsite> Outline has every Layout screen section locally cloned before other
  subsite outlines inherit from it.
- #<Subsite> Outline acts as the parent for the rest of the subsite outlines.
- #<Subsite> Home inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from
  #<Subsite> Outline, not Base Outline.
- #<Subsite> Home body class is gantry site-home withmaxwidth.
- #<Subsite> Grid inherits from #<Subsite> Outline except Utility and Main.
- #<Subsite> Grid Body Id is site-grid.
- #<Subsite> Sponsors inherits from #<Subsite> Outline except Aside.
- #<Subsite> Home/Grid/Sponsors Page Settings are local copies, not entangled.
- Head Properties and Assets on #<Subsite> Home/Grid/Sponsors match #<Subsite> Outline.
- Subsite Custom Content colors/fonts on #<Subsite> Outline are copied across
  #<Subsite> Home, Grid, and Sponsors.
`.trim();

const OUTLINE_CONVENTION_SECTIONS = {
  full: OUTLINE_CONVENTIONS,

  primary: `
Primary sites use Base Outline, #Outline, #Home, #Grid, and #Sponsors.
Base Outline owns primary Page Settings and cannot be assigned to pages.
#Outline is the assignable subpage outline and fully inherits layout/Page Settings
from Base Outline. #Home inherits Navigation, Bottom, Footer, Copyright, and
Offcanvas from Base Outline, but uses custom homepage sections and Body Classes
"gantry site-home withmaxwidth". #Grid customizes Utility/Main and uses Body Id
"site-grid". #Sponsors customizes Aside by removing/disabling Side Menu and keeping
SideBar A module position.
`.trim(),

  subsite: `
Subsites use #<Subsite> Outline, #<Subsite> Home, #<Subsite> Grid, and
#<Subsite> Sponsors. The subsite #Outline replaces Base Outline for that subsite
family and must not inherit layout or Page Settings from the primary Base Outline.
Before any other subsite outline inherits from it, #<Subsite> Outline must receive
a full local clone of Base Outline via gantry_layout_clone_all_from, clearing inherited
state on every copied node. Home, Grid, and Sponsors copy Page Settings locally from
#<Subsite> Outline with no entanglement/origin, and inherit shared layout sections
from #<Subsite> Outline, not from Base Outline.
`.trim(),

  page_settings: `
Subsite child outlines do not use entangled Page Settings. Use gantry_page_copy_from
from #<Subsite> Outline to #<Subsite> Home/Grid/Sponsors. The tool copies Head
Properties, Assets, Body, and Font Awesome as local values, clears page[origin] by
default, skips page[current_outline], and then applies only the expected tweaks:
subsite-home sets Body Classes to "gantry site-home withmaxwidth" and clears Body Id;
subsite-grid sets Body Id to "site-grid"; subsite-sponsors is an exact local copy.
Head Properties and Assets must match #<Subsite> Outline on all three child outlines.
`.trim(),

  clone: `
Gantry Clone means using the section Inheritance field's Clone option with all
three checkboxes enabled: Section Attributes, Block Attributes, and Particles within
Section. In tools, use gantry_layout_sections_clone_from for this behavior. Do not
use gantry_layout_section_clone for subsite setup because it only clears the inherit
field and does not copy source section/block/particle content.

The subsite #Outline must clone every Layout screen section/container from Base
Outline before #<Subsite> Home/Grid/Sponsors inherit from it. In tools, do this with
gantry_layout_clone_all_from so inheritance is cleared everywhere. Home then inherits
navigation, bottom, footer, copyright, and offcanvas from #<Subsite> Outline and clones
the other homepage sections from #Home. Grid inherits from #<Subsite> Outline except
Utility and Main/mainbar, which are cloned from #Grid. Sponsors inherits from #<Subsite>
Outline except Aside, which is cloned from #Sponsors.
`.trim(),

  workflow: `
Recommended workflow: gantry_outlines_list, resolve source/target ids, inspect with
gantry_layout_tree and gantry_page_settings_breakdown, duplicate matching source
outlines, use gantry_layout_clone_all_from for #<Subsite> Outline, copy Page Settings
locally with gantry_page_copy_from, clone required independent child sections with
gantry_layout_sections_clone_from (Section Attributes, Block Attributes, Particles
within Section), redirect shared section inheritance with gantry_layout_section_inherit,
edit Body Classes/Body Id with gantry_page_copy_from presets, and verify with the
checklist. Never delete and recreate outlines to fix inheritance mistakes.
`.trim(),

  checklist: `
Verify #Home uses Body Classes "gantry site-home withmaxwidth"; #Grid uses Body Id
"site-grid"; #Grid preserves grid-addpic; #Sponsors Aside has Side Menu removed or
disabled and SideBar A retained. For subsites, verify no Page Settings inherit from
Base Outline on #<Subsite> Outline, verify every #<Subsite> Outline layout section
was locally cloned first with no "Inheriting from Base Outline" locks, and verify
Home/Grid/Sponsors inherit their shared sections from #<Subsite> Outline instead of
Base Outline. Also verify Home/Grid/Sponsors have
local copied Page Settings with page[origin] blank, and that Head Properties/Assets
match #<Subsite> Outline.
`.trim(),
};

function getOutlineConventions(section = 'full') {
  return OUTLINE_CONVENTION_SECTIONS[section] || OUTLINE_CONVENTIONS;
}

module.exports = {
  OUTLINE_CONVENTIONS,
  OUTLINE_CONVENTION_SECTIONS,
  getOutlineConventions,
};
