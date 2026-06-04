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
- Subsite colors, fonts, and Custom Content live on the subsite #Outline Page Settings
  and flow to that subsite's Home, Grid, and Sponsors outlines by copy/inheritance
  from the subsite #Outline, never from Base Outline.

## Creating a Subsite Family

1. Create the subsite #Outline:
- Duplicate the primary #Outline and rename it #<Subsite> Outline.
- Break Base Outline inheritance by cloning the layout sections from Base Outline.
- For every section copied from Base Outline, use clone/copy behavior equivalent to
  selecting "Section Attributes" and "Particles within Section".
- In Page Settings, enable every Properties override checkbox so the subsite #Outline
  no longer inherits Base Outline Page Settings.
- Update Page Settings as a fresh site: Custom Content, colors, fonts, favicon/assets,
  meta, Body Classes, and any subsite-specific settings.
- Standard subpage Body Classes should include gantry site-sub withmaxwidth unless
  the site has a documented exception.

2. Create the subsite Home outline:
- Duplicate #Home and rename it #<Subsite> Home.
- Layout: Navigation, Bottom, Footer, Copyright, and Offcanvas Section inherit from
  #<Subsite> Outline.
- Layout: all other homepage design sections are cloned from #Home, not inherited
  from Base Outline.
- Page Settings: copy #<Subsite> Outline Page Settings.
- Body Classes: gantry site-home withmaxwidth.
- Body Classes must not include site-sub.

3. Create the subsite Grid outline:
- Duplicate #Grid and rename it #<Subsite> Grid.
- Layout: inherit from #<Subsite> Outline except the same Utility and Main sections
  that are custom on #Grid.
- Utility and Main should be cloned to match the primary #Grid behavior.
- Main Content Bottom A block CSS ID remains grid-addpic.
- Aside is empty at 5%, Sidebar is 5%, Main is 90%.
- Page Settings: copy #<Subsite> Outline Page Settings.
- Body Id: site-grid.

4. Create the subsite Sponsors outline:
- Duplicate #Sponsors and rename it #<Subsite> Sponsors.
- Layout: inherit every section from #<Subsite> Outline except Aside.
- Aside matches #Sponsors: Side Menu removed/disabled; SideBar A module position kept.
- Page Settings: exact copy of #<Subsite> Outline Page Settings.

## Gantry Tool Workflow

Before changing outlines:
- Run gantry_outlines_list and resolve titles to ids.
- Use gantry_layout_tree or gantry_layout_sections to inspect source and target outlines.
- Use gantry_page_settings_breakdown to inspect Page Settings on source outlines.
- Dry-run any layout mutation when a dryRun option exists.

Useful low-level tools:
- gantry_outlines_duplicate: create each new outline from the matching source outline.
- gantry_layout_section_inherit: point inherited sections to the correct parent outline.
- gantry_layout_section_clone: break inheritance on sections that must become independent.
- gantry_layout_copy_from: copy an entire layout when a target must be reset to a source.
- gantry_page_edit or gantry_page_body_edit: set Body Classes and Body Id.
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
- #<Subsite> Outline acts as the parent for the rest of the subsite outlines.
- #<Subsite> Home inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from
  #<Subsite> Outline, not Base Outline.
- #<Subsite> Home body class is gantry site-home withmaxwidth.
- #<Subsite> Grid inherits from #<Subsite> Outline except Utility and Main.
- #<Subsite> Grid Body Id is site-grid.
- #<Subsite> Sponsors inherits from #<Subsite> Outline except Aside.
- Subsite Custom Content colors/fonts on #<Subsite> Outline are reflected across
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
family and must not inherit Page Settings from the primary Base Outline. Home,
Grid, and Sponsors should copy Page Settings from #<Subsite> Outline and inherit
shared layout sections from #<Subsite> Outline, not from Base Outline.
`.trim(),

  workflow: `
Recommended workflow: gantry_outlines_list, resolve source/target ids, inspect with
gantry_layout_tree and gantry_page_settings_breakdown, duplicate matching source
outlines, redirect section inheritance with gantry_layout_section_inherit, break
inheritance with gantry_layout_section_clone where sections must be independent,
edit Body Classes/Body Id with gantry_page_body_edit, and verify with the checklist.
Never delete and recreate outlines to fix inheritance mistakes.
`.trim(),

  checklist: `
Verify #Home uses Body Classes "gantry site-home withmaxwidth"; #Grid uses Body Id
"site-grid"; #Grid preserves grid-addpic; #Sponsors Aside has Side Menu removed or
disabled and SideBar A retained. For subsites, verify no Page Settings inherit from
Base Outline on #<Subsite> Outline, and verify Home/Grid/Sponsors inherit their
shared sections from #<Subsite> Outline instead of Base Outline.
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
