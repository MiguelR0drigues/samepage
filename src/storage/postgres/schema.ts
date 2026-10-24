import { boolean, jsonb, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Candidate, Consensus, CorrectionVerdict, EntryStatus, EntryType, PendingAnswer, Position, SourceKind } from '../../domain/types';

export const people = pgTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  dashboardSeenAt: timestamp('dashboard_seen_at', { withTimezone: true }),
  dashboardNonce: text('dashboard_nonce'),
});

export const personTokens = pgTable('person_tokens', {
  personId: text('person_id').notNull().references(() => people.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entries = pgTable('entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').$type<EntryType>().notNull(),
  status: text('status').$type<EntryStatus>().notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  question: text('question'),
  positions: jsonb('positions').$type<Position[]>(),
  consensus: text('consensus').$type<Consensus>(),
  consensusReason: text('consensus_reason'),
  area: text('area').notNull(),
  sourceKind: text('source_kind').$type<SourceKind>().notNull(),
  sourceRef: text('source_ref'),
  recordedBy: text('recorded_by').notNull().references(() => people.id),
  updatedBy: text('updated_by').references(() => people.id),
  supersedesId: uuid('supersedes_id').references((): AnyPgColumn => entries.id),
  targetId: uuid('target_id').references((): AnyPgColumn => entries.id),
  resolutionNote: text('resolution_note'),
  workstreamId: uuid('workstream_id').references((): AnyPgColumn => entries.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by').references(() => people.id),
});

export const entryAuthors = pgTable('entry_authors', {
  entryId: uuid('entry_id').notNull().references(() => entries.id),
  personId: text('person_id').notNull().references(() => people.id),
}, (t) => [primaryKey({ columns: [t.entryId, t.personId] })]);

export const pending = pgTable('pending', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: text('person_id').notNull().references(() => people.id),
  candidate: jsonb('candidate').$type<Candidate>().notNull(),
  question: text('question').notNull(),
  sourceRef: text('source_ref'),
  status: text('status').$type<'open' | 'answered'>().notNull().default('open'),
  answer: text('answer').$type<PendingAnswer>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
});

export const corrections = pgTable('corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  personId: text('person_id').notNull().references(() => people.id),
  verdict: text('verdict').$type<CorrectionVerdict>().notNull(),
  candidate: jsonb('candidate').$type<Candidate>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
