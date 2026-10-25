import { Hono } from 'hono';
import { z } from 'zod';
import type { Person } from '../domain/types';
import { Capture, type Extraction } from '../service/capture';
import { MemoryError } from '../service/memory';
import type { Store } from '../storage/store';

// The model's output lands here: enums are exact and unknown keys are stripped (no passthrough).
const text = z.string().max(4000);
const extraction = z.object({
  session_ref: text,
  branch_hint: text.optional(),
  items: z.array(z.object({
    type: z.enum(['decision', 'principle', 'view', 'exploration']),
    title: text, content: text, area: text,
    authors: z.array(text).optional(),
    question: text.optional(),
    certainty: z.enum(['high', 'medium', 'low']),
    relation: z.enum(['new', 'updates', 'supersedes']),
    related_id: text.optional(),
    ask: text.optional(),
  })).max(20),
  update: z.object({
    title: text, content: text, area: text, workstream_id: text.optional(), workstream_title: text.optional(),
  }).nullish(),
}) satisfies z.ZodType<Extraction>;

export function extractorRoutes() {
  const app = new Hono<{ Variables: { person: Person; store: Store } }>();

  app.onError((e, c) => {
    if (e instanceof MemoryError) return c.json({ error: e.message }, 400);
    throw e;
  });

  app.get('/context', async (c) => c.json(await new Capture(c.get('store')).context(c.get('person'))));

  app.post('/apply', async (c) => {
    const parsed = extraction.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    return c.json(await new Capture(c.get('store')).apply(c.get('person'), parsed.data));
  });

  app.get('/changes', async (c) => {
    const since = Number(c.req.query('since'));
    if (!Number.isFinite(since) || since <= 0) return c.json({ error: 'since must be a time in milliseconds' }, 400);
    return c.json({ changes: await new Capture(c.get('store')).changes(c.get('person'), new Date(since)) });
  });

  app.post('/forget-session', async (c) => {
    const parsed = z.object({ session_ref: text.min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    return c.json(await new Capture(c.get('store')).forgetSession(c.get('person'), parsed.data.session_ref));
  });

  return app;
}
