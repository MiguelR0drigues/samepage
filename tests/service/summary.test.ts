import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { PostgresStore } from '../../src/storage/postgres/store';
import { Memory } from '../../src/service/memory';
import { sessionSummary } from '../../src/service/summary';
import type { Person } from '../../src/domain/types';

let store: PostgresStore;
let memory: Memory;
let miguel: Person;
let joao: Person;

beforeEach(async () => {
  store = new PostgresStore(await createTestDb());
  memory = new Memory(store);
  miguel = await store.addPerson({ id: 'miguel', name: 'Miguel', isSystem: false }, 'h-miguel');
  joao = await store.addPerson({ id: 'joao', name: 'Joao', isSystem: false }, 'h-joao');
});

const fresh = async (id: string) => (await store.listPeople()).find((p) => p.id === id)!;

describe('sessionSummary', () => {
  it('includes principles, decisions and proposals', async () => {
    await memory.record(miguel, { type: 'principle', title: 'Keep it small', content: 'Prefer small changes.', area: 'process' });
    const d = await memory.record(miguel, { type: 'decision', title: 'Use Neon', content: 'We use Neon.', area: 'infra' });
    await memory.proposeRevision(joao, d.id, { title: 'Use Supabase', content: 'Switch.', justification: 'cheaper' });

    const text = await sessionSummary(store, miguel, new Date());
    expect(text).toContain('# Team memory (SamePage)');
    expect(text).toContain('- Keep it small: Prefer small changes.');
    expect(text).toContain(`- [${d.id.slice(0, 8)}] Use Neon (infra, ${new Date().toISOString().slice(0, 10)})`);
    expect(text).toContain('## Open proposals');
    expect(text).toContain('→ revises "Use Neon"');
    expect(text).toContain('Use the samepage tools for details.');
  });

  it("changes exclude the person's own changes and show removed entries", async () => {
    await store.touchLastSeen('miguel', new Date(Date.now() - 60_000));
    const mine = await memory.record(miguel, { type: 'view', title: 'My own view', content: 'x', area: 'a' });
    const theirs = await memory.record(joao, { type: 'view', title: 'Joao view', content: 'x', area: 'a' });
    const doomed = await memory.record(joao, { type: 'view', title: 'Doomed view', content: 'x', area: 'a' });
    await memory.remove(joao, doomed.id);

    const text = await sessionSummary(store, await fresh('miguel'), new Date());
    expect(text).toContain('## New since your last session');
    expect(text).toContain('- new: Joao view (by joao)');
    expect(text).toContain('- removed: Doomed view (by joao)');
    expect(text).not.toContain('My own view');
    expect(mine.id).not.toBe(theirs.id);
  });

  it('first session has no changes section and the second one does', async () => {
    const first = await sessionSummary(store, miguel, new Date());
    expect(first).not.toContain('New since your last session');

    await new Promise((r) => setTimeout(r, 20));
    await memory.record(joao, { type: 'view', title: 'Later view', content: 'x', area: 'a' });
    const second = await sessionSummary(store, await fresh('miguel'), new Date());
    expect(second).toContain('- new: Later view (by joao)');
  });

  it('never exceeds 2000 characters and keeps the footer, header and newest sections', async () => {
    await store.touchLastSeen('miguel', new Date(Date.now() - 60_000));
    for (let i = 0; i < 30; i++) {
      await memory.record(miguel, { type: 'principle', title: `Principle ${i}`, content: 'long '.repeat(80), area: 'p' });
    }
    await memory.record(miguel, { type: 'decision', title: 'Use Neon', content: 'We use Neon.', area: 'infra' });
    await memory.record(joao, { type: 'view', title: 'Joao view', content: 'x', area: 'a' });

    const text = await sessionSummary(store, await fresh('miguel'), new Date());
    const lines = text.split('\n');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(lines[0]).toBe('# Team memory (SamePage)');
    expect(lines.at(-1)).toBe('Use the samepage tools for details.');
    expect(text).toContain('- new: Joao view (by joao)');
    expect(text).toContain('- [');
    lines.forEach((l, i) => {
      if (l.startsWith('## ')) expect(lines[i + 1]).toMatch(/^- /);
    });
  });

  it('deleted principles and decisions are not listed', async () => {
    const p = await memory.record(miguel, { type: 'principle', title: 'Gone principle', content: 'x', area: 'p' });
    const d = await memory.record(miguel, { type: 'decision', title: 'Gone decision', content: 'x', area: 'a' });
    await memory.record(miguel, { type: 'principle', title: 'Kept principle', content: 'x', area: 'p' });
    await memory.remove(miguel, p.id);
    await memory.remove(miguel, d.id);

    const text = await sessionSummary(store, miguel, new Date());
    expect(text).toContain('Kept principle');
    expect(text).not.toContain('Gone principle');
    expect(text).not.toContain('Gone decision');
    expect(text).not.toContain('## Recent decisions');
  });
});
