/**
 * pnpm db:migrate [--dry-run]
 *
 * Applies every migration in supabase/migrations that hasn't run yet, each in
 * its own transaction, and records it in supabase_migrations.schema_migrations
 * (the same table the Supabase CLI uses, so the two stay interchangeable).
 *
 * --dry-run applies all pending migrations inside one transaction, prints what
 * it would have created along with a few security invariants, and rolls back.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const dryRun = process.argv.includes('--dry-run');

config({ path: join(ROOT, '.env'), quiet: true });
const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('SUPABASE_DB_URL is not set. See docs/SETUP.md.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

class Rollback extends Error {}

async function main() {
  await sql`create schema if not exists supabase_migrations`;
  await sql`
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    )`;

  const applied = new Set(
    (
      await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`
    ).map((r) => r.version),
  );

  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()
    .map((file) => ({ file, version: file.slice(0, 14), name: file.slice(15, -4) }))
    .filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('Database is up to date.');
    return;
  }

  if (dryRun) {
    try {
      await sql.begin(async (tx) => {
        for (const m of pending) {
          console.log(`would apply ${m.file}`);
          await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8'));
        }
        await reportInvariants(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      console.log('\nDry run succeeded. Nothing was changed.');
    }
    return;
  }

  for (const m of pending) {
    const body = readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        insert into supabase_migrations.schema_migrations (version, name, statements)
        values (${m.version}, ${m.name}, ${[body]})`;
    });
    console.log(`applied ${m.file}`);
  }
  await reportInvariants(sql);
}

/** Checks that should hold after every migration. Exits non-zero if one fails. */
async function reportInvariants(db: postgres.Sql | postgres.TransactionSql) {
  const tables = await db<{ relname: string; rls: boolean }[]>`
    select c.relname, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by 1`;
  const secretColumns = await db<{ col: string; readable: boolean }[]>`
    select t.tbl || '.' || t.col as col,
           has_column_privilege('authenticated', 'public.' || t.tbl, t.col, 'select') as readable
    from (values ('api_keys', 'key_hash'), ('view_keys', 'encrypted_key'),
                 ('webhooks', 'secret_encrypted'), ('webauthn_credentials', 'public_key')) as t(tbl, col)
    where exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = t.tbl)`;
  const amountColumns = await db<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name in ('transfers', 'deposits', 'withdrawals', 'events')
      and data_type in ('numeric', 'bigint', 'integer', 'real', 'double precision')`;

  console.log(`\npublic tables: ${tables.map((t) => t.relname).join(', ')}`);
  const problems = [
    ...tables.filter((t) => !t.rls).map((t) => `RLS disabled on ${t.relname}`),
    ...secretColumns.filter((c) => c.readable).map((c) => `authenticated can read ${c.col}`),
    ...amountColumns.map((c) => `a money table has a numeric column "${c.column_name}"`),
  ];
  if (problems.length) {
    console.error(`\nInvariant violations:\n  - ${problems.join('\n  - ')}`);
    throw new Error('invariants failed');
  }
  console.log('invariants: RLS on every table, secret columns hidden, no plaintext amount columns');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
