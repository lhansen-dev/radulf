---
name: Radulf
description: A dark, quiet operations console where one amber lamp marks what is live and what needs you.
colors:
  watchfire-amber: "#fbbf24"
  watchfire-ember: "#d97706"
  on-amber: "#090b0e"
  night-black: "#0b0d10"
  night-surface: "#0e1115"
  moon-gray: "#d7dce2"
  review-violet: "#c4b5fd"
  plan-cyan: "#67e8f9"
  paused-sky: "#7dd3fc"
  attention-red: "#fca5a5"
  success-green: "#86efac"
  approve-green: "#15803d"
  queued-slate: "#cbd5e1"
typography:
  headline:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Geist, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "0.14em"
  code:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  "2xl": "16px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "7": "28px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.watchfire-ember}"
    textColor: "{colors.on-amber}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.watchfire-amber}"
  button-secondary:
    backgroundColor: "rgb(215 220 226 / 0.10)"
    textColor: "rgb(215 220 226 / 0.80)"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "rgb(215 220 226 / 0.15)"
  button-approve:
    backgroundColor: "{colors.approve-green}"
    textColor: "{colors.moon-gray}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
    height: "44px"
  button-approve-hover:
    backgroundColor: "#16a34a"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "rgb(215 220 226 / 0.60)"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "rgb(215 220 226 / 0.06)"
  input:
    backgroundColor: "{colors.night-black}"
    textColor: "{colors.moon-gray}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
    height: "44px"
  chip-view:
    backgroundColor: "rgb(215 220 226 / 0.03)"
    textColor: "rgb(215 220 226 / 0.55)"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "0 14px"
    height: "44px"
  chip-view-active:
    backgroundColor: "rgb(251 191 36 / 0.12)"
    textColor: "#fde68a"
  nav-rail-link:
    backgroundColor: "transparent"
    textColor: "rgb(215 220 226 / 0.50)"
    rounded: "9px"
    padding: "0"
    height: "52px"
  nav-rail-link-active:
    backgroundColor: "rgb(251 191 36 / 0.09)"
    textColor: "{colors.watchfire-amber}"
  card-section:
    backgroundColor: "rgb(215 220 226 / 0.025)"
    textColor: "{colors.moon-gray}"
    rounded: "{rounded.xl}"
    padding: "16px"
  dialog:
    backgroundColor: "{colors.night-surface}"
    textColor: "{colors.moon-gray}"
    rounded: "{rounded.2xl}"
    padding: "16px"
---

# Design System: Radulf

## Overview

**Creative North Star: "The Night Watch"**

Radulf is a dark, quiet console where the wolf works while you rest. The surfaces are near-black and calm, the text is a cool moon gray at graded opacities, and one warm light, Watchfire Amber, stays lit on whatever is live or whatever needs you. Nothing else glows. The interface is calm and vigilant: low visual noise at rest, but a task that needs a decision is unmistakable from across the room.

The system is warm-dark and precise. Numbers are tabular, progress is stated in iterations and elapsed time, and status is always a glyph plus a colored word, never a bare spinner. It is understated and confident: no gradients, no glow, no marketing energy. Brand lives in small, exact details: the amber `R` mark in the rail, the tracked uppercase eyebrow above a page title, the hairline that separates one task row from the next.

The whole world is built from five CSS variables, background, surface, foreground, accent, and accent-strong, and every neutral is the foreground color at a fixed alpha. That is what lets the same interface wear ten user-selectable themes. Default dark is the canonical home. The other nine are re-skins that must keep working, not targets to design for.

**Key Characteristics:**
- Near-black tonal surfaces separated by hairline borders, not shadows
- One amber accent for live state and the single primary action per view
- Semantic status tones on small marks and pills only, never as lane backgrounds
- Geist for the interface, Geist Mono for diffs, transcripts, and code
- Dense, vertical, list-first layout that reads the same on a phone and a desktop
- Every control at least 44px tall, keyboard and screen reader operable

## Colors

The palette is one warm lamp against a cool, near-black night, with a small set of status tones borrowed from Tailwind's default palette.

### Primary
- **Watchfire Amber** `#fbbf24`: the accent. Active navigation, the focus ring, live status marks, links inside prose, and the text of the active view chip. On dark it reads as the one lamp left on.
- **Watchfire Ember** `#d97706`: the deeper accent for filled primary buttons, the mobile New Task button, and the rail's Task button. Hovering a filled button brightens it to Watchfire Amber.
- **On Amber** `#090b0e`: text on any amber fill.

### Neutral
- **Night Black** `#0b0d10`: the page background and the fill of settings inputs.
- **Night Surface** `#0e1115`: the raised layer. Desktop rail, bottom nav at 96%, dialogs, overflow menus, settings section cards.
- **Moon Gray** `#d7dce2`: the foreground. Full strength for titles, then graded: 90% for row titles, 70% to 80% for body and secondary buttons, 50% to 60% for supporting copy, 35% to 45% for metadata and eyebrows. Borders are 8% to 10%, hover fills 6%, section fills 2.5% to 5%.

### Status tones
These are literal Tailwind palette values, not theme variables, so they do not follow the theme.
- **Review Violet** `#c4b5fd`: ready for review, the Needs you section header, and the Review row action on a 15% violet fill.
- **Plan Cyan** `#67e8f9`: a plan awaiting approval.
- **Paused Sky** `#7dd3fc`: paused, and the Continue action.
- **Attention Red** `#fca5a5`: needs attention, danger menu items, and error banners on a `#450a0a` ground at 40%.
- **Success Green** `#86efac`: completed and the Done section header. The Auto Mode dot is the brighter `#4ade80`.
- **Approve Green** `#15803d`: the one filled green, the Approve and merge button.
- **Queued Slate** `#cbd5e1`: queued and Up next, the neutral status.

### Named Rules
**The One Lamp Rule.** Watchfire Amber marks what is live and the single primary action on a view. One filled amber button per screen. Amber never decorates.

**The Alpha Neutral Rule.** Every neutral surface, border, divider, and secondary text is Moon Gray at a fixed alpha. No new gray hex is ever introduced. This is what makes ten themes work from five variables.

**The Small Mark Rule.** Status color lives on a glyph, a pill, a section eyebrow, or a row action fill at 15%. It is never a full-width background or a lane identity.

## Typography

**Display Font:** none. The interface has no display tier.
**Body Font:** Geist, with `system-ui, sans-serif` fallback, loaded through `next/font`.
**Label/Mono Font:** Geist Mono, with `ui-monospace, monospace` fallback.

**Character:** A neutral grotesque set small and tight. It stays out of the way of the content, which is task titles, iteration counts, and diffs. Weight does the hierarchy work, not size.

### Hierarchy
- **Headline** 600, `1.5rem`, tracking `-0.025em`: the page title on Work and Settings, always under an eyebrow.
- **Title** 600, `1.125rem`: task and review page titles, dialog titles, and settings section headings.
- **Section title** 500, `0.875rem`: the `h3` inside a card section, such as Events or Changes summary.
- **Row title** 500, `0.95rem`, line-height `1.25rem`: a task's title in the feed, at 90% Moon Gray.
- **Body** 400, `0.875rem`: the working size. Buttons, inputs, menu items, descriptions.
- **Meta** 400, `0.75rem`: timestamps, counts, provider names, at 40% to 60% Moon Gray, with `tabular-nums` on anything numeric.
- **Label** 500 to 600, `0.75rem` or `11px`, uppercase, tracking `0.12em` to `0.16em`: the WORKSPACE eyebrow at 35%, section headers in their status tone, settings nav group names.
- **Code** 400, `0.82rem` to `0.85rem`, Geist Mono: diffs, transcripts, inline code in docs.
- **Doc prose** 400, `0.925rem`, line-height `1.7`: the Docs tab body at 78% Moon Gray.

### Named Rules
**The Eyebrow Rule.** Uppercase and letter-spacing belong only to eyebrows and section headers at `0.75rem` or smaller. Titles are never uppercase.

**The Tabular Number Rule.** Iterations, counts, durations, and timestamps are set with `tabular-nums` so live values do not jitter.

## Layout

The layout is a single vertical reading direction. Radulf is mobile-first, and the desktop is the same page with a rail attached, never a second application.

- **Shell.** Below `1024px` there is a fixed bottom navigation bar, `64px` minimum plus the safe-area inset, with a `56px` round New Task button floating `20px` from the right edge above it. From `1024px` the shell becomes a two-column grid: an `88px` sticky rail on the left and content on the right. The rail holds a `44px` brand mark, the five destinations as `52px` icon-over-label links, then a footer pinned to the bottom with the Task button and the GitHub provenance link.
- **Content widths.** Work is centered at `800px`. Task detail is `64rem`. Review is `80rem` with a sticky sidebar from `1024px`. Settings is a two-column layout with a sticky section nav on the left. Horizontal padding is `16px` on phones and `24px` from `640px`.
- **Vertical rhythm.** The 4px grid: `4`, `8`, `12`, `16`, `20`, `24`, `28`, `32`. Sections in the Work feed sit `28px` apart. Rows are `14px` top and bottom. Card sections use `16px` padding, settings cards `20px` to `24px`.
- **Rows, not cards.** Tasks are list rows separated by hairlines: a `border-y` at 8% Moon Gray around the group and a `divide-y` at 7% white between rows. Row anatomy is a `20px` status glyph, then title and meta, then a `44px` action button and an overflow menu. A row's hover is a 2.5% fill.
- **Page header.** Eyebrow, headline, and controls on one line. A one-line automation banner beneath it reports Auto Mode with an `8px` dot.
- **View chips.** A horizontally scrolling row of pill filters below the banner, edge-to-edge on phones with negative margin.
- **Horizontal scroll** is reserved for diffs and the settings section nav on narrow screens.

### Named Rules
**The 44 Rule.** Every button, link, select, input, and summary is at least `44px` tall, enforced globally in CSS. Drag and hover may enhance, never gate.

**The One Direction Rule.** The primary surface scrolls vertically. The row is the unit. Kanban lanes are not drawn.

## Elevation & Depth

Flat by default. Depth is tonal: a layer is a slightly lighter fill of Moon Gray at 2.5% to 6% with a hairline border at 8% to 10%. Night Surface is the one raised material, used for anything that sits above the page in the stacking order. Shadows exist, but only when an element floats.

### Shadow Vocabulary
- **Floating dialog** `0 25px 50px -12px rgb(0 0 0 / 0.25)`: the task dialog and the largest overflow menus, on Night Surface over a `rgb(0 0 0 / 0.7)` scrim.
- **Floating menu** `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`: the review options menu.
- **Floating button** `0 8px 30px rgb(0 0 0 / 0.45)`: the mobile New Task button only.
- **Toggle knob** `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)`: the switch thumb.
- **Blur** `16px` behind the bottom nav and `8px` behind the review action bar, both over Night Surface at 95% to 96%.

### Named Rules
**The Floating Layer Rule.** A shadow means the element floats above the page: dialog, menu, floating button. Rows, cards, banners, and inputs never cast one.

## Shapes

Gently rounded, never pill-shaped except where the shape carries meaning. The workhorse radius is `8px`: buttons, inputs, menu items, nav links, row actions, and filled banners. Containers step up: `12px` for section cards, overflow menus, and the brand mark; `16px` for dialogs, and on the top corners only when a dialog docks to the bottom edge on phones. Down the scale, `4px` is the flat radius of the review page's verdict boxes, warning banners, action buttons, and diff highlights; `6px` is the queue reorder buttons and row menu items. Full pills at `999px` are reserved for view filter chips, the on and off status pill, the switch, the queue position badge, and the floating New Task button.

Borders are hairlines, `1px` at 8% to 15% Moon Gray. A `3px` left rule in Watchfire Amber at 55% marks blockquotes in docs. The rail links use a one-off `9px` radius; new work uses `8px`.

## Components

### Buttons
Quiet and utilitarian: tonal fills, weight 500 or 600, `44px` tall.
- **Shape:** `8px`, or `4px` in the review and task detail action bars.
- **Primary:** Watchfire Ember fill with On Amber text, `16px` horizontal padding, weight 600. Hover brightens to Watchfire Amber. One per view: New task, Create task, Save settings, Start now.
- **Secondary:** Moon Gray at 10% fill, text at 80%, hover 15%. Used for Details, Continue, and Reject with feedback.
- **Outlined secondary:** the settings variant adds a 15% border over a 3% fill, hover 7%. Disabled is 40% opacity everywhere.
- **Approve:** the only filled green, `#15803d`, hover `#16a34a`, in the fixed review action bar beside a secondary Reject.
- **Ghost and menu items:** transparent, text at 60%, hover 6% fill, full width and left aligned in menus. Danger items are Attention Red with a red 10% hover.
- **Icon buttons:** `44px` square, `8px` radius, 6% fill for the overflow trigger. Reorder arrows are 45% text with a 6% hover fill, and 20% opacity when disabled.
- **Focus:** a `2px` Watchfire Amber outline offset `3px`, applied globally.

### Chips
- **View filter:** full pill, `44px` tall, `14px` horizontal padding, hairline 10% border, 3% fill, text 55%, with a tabular count at 40%. Active: amber border at 60%, amber fill at 12%, text `#fde68a`.
- **Model picker:** `4px` radius, `8px` by `4px` padding, `0.75rem`. Selected shows an amber border and amber text.
- **Status pill:** full pill, `10px` by `2px` padding, `0.75rem`, a filled or hollow glyph, then the label and On or Off. On is an Ember border at 50% over `#451a03` at 30%. Off is a 10% border with 40% text.

### Cards / Containers
- **Corner Style:** `12px`.
- **Background:** Moon Gray at 2.5% for task detail sections and the empty state. Night Surface for settings sections.
- **Shadow Strategy:** none. See The Floating Layer Rule.
- **Border:** hairline at 8% to 10%.
- **Internal Padding:** `16px` for detail sections, `20px` to `24px` for settings, `24px` for the empty state and the first-run welcome at `16px` radius.
- **Banners:** `8px` radius, `12px` padding, `0.875rem`. Info is a 7% border over a 2.5% fill at 55% text. Warning is an amber 30% border over an amber 10% fill with `#fde68a` text. Error is red 30% over red 10% with `#fecaca` text. Review page banners are flatter at `4px` on `#450a0a` or `#451a03` grounds at 40%.

### Inputs / Fields
- **Style:** `8px` radius, `12px` by `8px` padding, `0.875rem`. Settings inputs sit on Night Black with a 15% border. Dialog inputs use a 10% border over a 5% fill. Labels are `0.875rem` at 70% above the field, help text `0.75rem` at 40% below.
- **Focus:** the border shifts to Watchfire Amber, plus the global outline. Hover raises the border to 25%.
- **Placeholder:** 35% Moon Gray.
- **Switch:** `40px` by `24px` full pill, 20% fill, amber when checked, with a `16px` knob on Night Black that slides `16px`.
- **Theme picker:** radio cards at `8px` with a `56px` miniature of the theme. Selected gets an amber border and an amber 5% fill.

### Navigation
- **Rail:** `88px` wide on Night Surface with a 10% right border. Links are `52px` tall, `9px` radius, a `1.125rem` icon above a `0.68rem` label at 50%. Active is amber text on an amber 9% fill with `aria-current`.
- **Bottom nav:** three columns of `56px` links at `8px`, `0.7rem` labels at 52%, the same active treatment at an 8% fill, over Night Surface at 96% with `16px` blur.
- **Settings section nav:** `8px` links with an `18px` stroke icon at `1.5` weight, `12px` by `10px` padding. Active is amber text on an amber 10% fill.
- **Back link:** an arrow and Work at 50%, full strength on hover.
- **Docs nav:** grouped under eyebrows, with the active item in amber on a subtle amber fill.

### Task Row
The signature component. A `20px` glyph in the status tone, then a `0.95rem` title at 90% with an optional amber repo tag, a `0.75rem` amber detail such as the iteration count and elapsed time, then one primary row action and an overflow menu. The description clamps to two lines at 48%. Queue rows add a `28px` round position badge at a 4% fill and up and down reorder buttons. The whole row is a link target with a 2.5% hover fill, and the section header above it is an uppercase eyebrow in the section's tone with a count at 35%.

### Status Marks
State is a glyph, a tone, and a word together: `○` Backlog, `◎` Queued, `◔` Planning, `◇` Ready, `●` Running, `◆` Ready for review, `◌` Applying review, `⏸` Paused, `◉` Plan ready, `!` Needs attention, `✓` Completed. The glyph is `0.875rem` bold in the tone. The word appears in the row detail or the pill. Navigation uses matching geometric glyphs, `▤ ◫ ◷ ⚙ ▦`, while the settings nav uses inline stroke SVG at `1.5` weight. New icons follow whichever family the surface already uses.

### Skeleton and Live State
Loading is a pulsing skeleton of `8px` blocks at 10% and 4% with an `sr-only` label. Motion is `transition-colors` at Tailwind's default `150ms` and `transition-transform` on the switch. `prefers-reduced-motion` collapses every animation and transition to `0.01ms`.

### Named Rules
**The Labelled Pulse Rule.** Any pulsing or animated live state carries a non-animated text label. A spinner alone never appears.

## Do's and Don'ts

### Do:
- **Do** build every color from the five theme variables and Moon Gray at alpha, so all ten themes keep working.
- **Do** use one Watchfire Ember filled button per view and let it brighten to Watchfire Amber on hover.
- **Do** separate rows with hairlines at 7% to 10% and give containers a `12px` radius with a hairline border.
- **Do** keep uppercase and tracking to eyebrows and section headers at `0.75rem` or smaller.
- **Do** show state as glyph, tone, and word together, with `tabular-nums` on every live number.
- **Do** give every control a `44px` hit area and a visible amber focus ring, and pair every pulse with an `sr-only` label.
- **Do** put shadows only on the dialog, menus, and the floating New Task button.
- **Do** write Work, task, and queue in labels, never Board or column.

### Don't:
- **Don't** introduce a new gray hex, a gradient, a glow, or a colored full-width lane background.
- **Don't** add hard-coded Tailwind palette tones beyond the existing status set. Those tones are dark-tuned and are the known weak point on light themes.
- **Don't** put a shadow, a heavy border, or a card treatment on task rows.
- **Don't** use Watchfire Amber as decoration or on more than one filled control per view.
- **Don't** rely on hover or drag as the only path to an action.
- **Don't** replace a status word with a spinner or an icon alone.
