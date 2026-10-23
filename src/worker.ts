import type { ExecutionContext } from 'hono';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { createApp, type Env } from './http/app';
import * as schema from './storage/postgres/schema';
import { PostgresStore } from './storage/postgres/store';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Workers cannot share I/O objects across requests, so each request gets its own pool.
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    try {
      return await createApp(() => new PostgresStore(drizzle(pool, { schema }))).fetch(request, env, ctx);
    } finally {
      ctx.waitUntil(pool.end());
    }
  },
};
