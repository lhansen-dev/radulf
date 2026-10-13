# 34: Legible muted text

Decided 2026-10-13. Applies [10-mobile-first-ui.md](10-mobile-first-ui.md)'s
binding WCAG 2.2 AA contrast requirement to secondary text.

## The evidence

axe, run against six pages on the default theme, reported about 180 elements
under AA's 4.5:1. Nearly all were secondary text written as a foreground alpha
(`text-foreground/35` to `/60`), measuring 2.6 to 4.3:1. No single alpha fixes
it: the alpha that passes depends on the palette, from 54% on the default
theme to 96% on Solarized Dark, and Tokyo Day and Solarized Light fall short
even at full strength because their foreground itself is under 4.5:1. The
light themes also rendered status colours (red, violet, slate and the rest,
written as pale text over dark tints) as pale on pale.

## Decisions

**1. One muted colour per theme.** Each theme sets `--muted` (Tailwind
`text-muted`) to the least share of its foreground that reads at about 4.6:1
on its background and surface. Secondary text uses it; the separate dimmed
levels collapse into one, which is the cost of legibility.

**2. Light themes mirror the status scale.** Shades 50 to 400 and 800 to 950
swap with their mirror; 500 to 700, the solid fills that carry white text,
stay put.

**3. A test holds the rule.** `src/app/designRules.test.ts` fails on any plain
`text-foreground` alpha under 61% in `src/app`.

**4. Use each palette's own strongest text colour.** Where a theme used a
dimmer foreground than its palette offers for text, it now uses the stronger
one: Tokyo Night's canonical `fg` (#c0caf5), Gruvbox's `fg0` (dark #fbf1c7,
light #282828), Nord's `nord6` (#eceff4), and Solarized Light's emphasized
`base01` (#586e75). Failing elements across six pages fell from 168 to 1 on
Tokyo Night and from 205 to 19 on Gruvbox Light.

**Open:** Solarized (both), Tokyo Day and Nord Light still fail widely: their
palettes hold no stronger text colour, so reaching AA there means departing
from the palette, a design decision this spec does not take.
