import { boolean, jsonb, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Consensus, EntryStatus, EntryType, Position, SourceKind } from '../../domain/types';

export const people = pgTable('people', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  tokenHash: text('token_hash').notNull().unique(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by').references(() => people.id),
});

export const entryAuthors = pgTable('entry_authors', {
  entryId: uuid('entry_id').notNull().references(() => entries.id),
  personId: text('person_id').notNull().references(() => people.id),
}, (t) => [primaryKey({ columns: [t.entryId, t.personId] })]);
