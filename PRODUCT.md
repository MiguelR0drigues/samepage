# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Small teams (2–10 people) that install SamePage: founders and teammates across product, engineering, marketing and positioning, not only engineers. Each person works mostly through their own AI agent (Claude Code today); the dashboard is where a person checks the shared memory directly, a few times a week, usually on a laptop.

## Product Purpose

SamePage is shared team memory for AI agents, and its job is that no teammate's agent acts on a decision that has changed. Decisions made in calls, chats and agent sessions are captured once, with who argued what and how strong the consensus was; when one changes, the old version is superseded and the agents that used it are told. Nobody re-explains context.

The dashboard is optional: everything it does an agent can do too. Its first job is answering "what needs me?": proposals waiting for my verdict, then what others changed since my last visit. Then it is the place to read a decision in full, see where each person stands on a topic, and see who is working on what.

## Positioning

Storing context is not the pitch; vector databases and wikis already do that. The pitch is capturing the decisions nobody writes down and keeping every agent on the current version.

It keeps the debate, not just the outcome: the question, each person's position and arguments, the verdict, the consensus level and the supersede history. Entries always have authors, so a personal view is never confused with a team decision, and a team decision cannot be overturned silently: its owner confirms any change, and in areas the team marks as joint (pricing, vision…) another teammate must accept the proposal.

## Operating Context

- Sign-in is a one-time link from the agent (`open_dashboard`), then a 30-day cookie. No passwords.
- Entry types: decision, principle, view, exploration, proposal, workstream, update. Statuses: active, superseded, under review, open, accepted, rejected, in progress, blocked, done.
- Areas are free-form lowercase slugs written by agents (pricing, infra, gtm…).
- Server-rendered HTML on a Cloudflare Worker (Hono); JavaScript allowed only as a small enhancement.

## Capabilities and Constraints

- Pages: Home (what needs me, what's new, search, timeline), entry/decision detail, proposals (accept/reject), who thinks what (views per area per person), team (workstreams, last activity, blockers), workstream detail (progress, rename, status, merge).
- You cannot close your own proposal. Deleted entries never show their title or content.
- All agent-written text is untrusted and must be escaped.
- All product text in English.

## Brand Commitments

- Logo in `docs/brand/`: a capital S drawn as five stacked strips (the edges of a stack of pages) with a coral curve linking top and bottom (the thread that keeps everyone on the same page).
- Palette: ink navy `#14213D`, ivory `#F4F1EA`, coral `#FF6B4A`. The dashboard uses these as its own colours.
- Wordmark set in Inter, weight 600.

## Product Principles

- What needs a human comes first; everything else is context.
- Show the reasoning, not just the result: positions and consensus are first-class.
- Authorship is always visible.
- Scannable, not read: one obvious place to look first, then colour, icons and avatars carry the kind of thing and who did it. Plain text walls are a failure.
- Built for growth: anything that accumulates (proposals, views, workstreams) gets search, filters or a cap from day one.
- Counts only when they name real things: a summary tile always says what it counts and what is inside; no gradients, no vanity metrics.
