---
version: 1
slug: "src-dashboard-html-ts"
primary_target: "src/dashboard/html.ts"
related_targets: ["src/dashboard/pages.ts"]
---

# Dashboard surface brief

Scope: the signed-in web dashboard (/dashboard/*): shell, Home, entry/decision, proposals, who thinks what, team, workstream, error page. Mode: Operate.

Audience and job: teammates of any small team using SamePage, on a laptop a few times a week. First job: "what needs me?" (proposals awaiting my verdict, then what others changed since my last visit). Then: read a decision in full, see where each person stands per area, see who works on what.

Constraints: server-rendered Hono HTML, no JS required. All agent text escaped. English. Avoid: generic SaaS template feel, too dense, too sparse.

Revision 2 (user feedback on the first build): too hard to read, "pretty much just text", no clear place to look; Proposals and Who thinks what will not scale; Team will get messy over time; use the logo's colours. The palette is pinned by the brand (PRODUCT.md Brand Commitments) and replaces the earlier buckram-green world.

## Direction contract

THESIS: The team's shared memory at a glance: one place to look first (what needs your verdict), then everything else colour-coded by kind and person so it can be scanned, not read. Refuses both the all-text minute book and the anonymous KPI dashboard: every tile is a count of real things with the thing named.

OWN-WORLD: Brand navy rail with the S symbol, ivory ground, white cards with a soft shadow, coral only for what needs you (Accept, the verdict count, the hot tile, the active nav marker, the verdict card's top edge). Each entry type has its own colour and Lucide-style icon tile; each person has a stable avatar colour. Sans throughout (Inter, else system UI). Status as dot chips.

STORY: The teammate lands on Home, sees the coral "Needs your verdict" tile, reads the current vs proposed verdict side by side and accepts or rejects inline; then scans the day-grouped feed; the aside shows who is on what and the decision timeline. Lists that grow (proposals, views, workstreams) get tabs, filters, one-area-at-a-time and a capped Done lane.

FIRST VIEWPORT: Navy rail left (logo, icon nav with coral verdict count, person at foot). Sticky top bar with global search and area filter. Greeting with a one-line status, then four focus tiles (Needs your verdict in navy with coral count; New since your visit; Blocked workstreams; Active decisions). Below: Needs your verdict cards with Current/Proposed side by side and Accept/Reject; aside with Team now and Decision timeline (status chip + division tally with "2–1").

FORM: Brand-led revision of The Minute Book (seed key 76509655); palette pinned by the brand, signature move kept: the division tally.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
