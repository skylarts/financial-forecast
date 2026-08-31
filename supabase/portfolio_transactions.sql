-- One row per transaction, so a ledger edit syncs the rows that changed
-- instead of re-uploading the whole portfolio.
--
-- The `portfolios` table in portfolio_sync.sql keeps everything else -- the
-- accounts and the securities, which are tens of rows and change rarely. Only
-- the transactions grow without bound, and they were the entire problem: at
-- 10,000 rows the portfolio blob is 2.8 MB and at 100,000 it is roughly 28 MB,
-- re-sent in full on a 1.5-second debounce after every single edit. That is
-- slow at ten thousand rows and simply fails at a hundred thousand.
--
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (every statement is
-- idempotent). Run it BEFORE deploying the app change; the app backfills this
-- table from the existing blob on the first sync after it lands, and until
-- then it keeps reading the blob, so there is no window where data is missing.

create table if not exists portfolio_transactions (
  -- Who this ledger belongs to: the household when there is one, otherwise the
  -- individual user. It is the identity the rows are keyed by, and it exists
  -- because the two are genuinely one ledger.
  --
  -- Keying on `user_id` instead would break household sharing in the worst
  -- possible way: spouses share one portfolio, so both would write the same
  -- transaction under their own id, the household read would return both
  -- copies, and every shared holding would silently double.
  scope_id uuid not null,
  -- The transaction's own id, which the app already generates and keeps stable.
  id text not null,
  -- Kept alongside `scope_id` so the per-user and per-household row-level
  -- security policies below each have a column to match on.
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id),
  -- The whole transaction as the app stores it. Kept as one column rather than
  -- spread into typed columns because the app's zod schema is the source of
  -- truth for this shape, and mirroring it here would mean a migration every
  -- time a field is added.
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (scope_id, id)
);

create index if not exists portfolio_transactions_household_idx
  on portfolio_transactions (household_id);
create index if not exists portfolio_transactions_user_idx
  on portfolio_transactions (user_id);

alter table portfolio_transactions enable row level security;

-- Per-user access: a signed-in user can read/write their own rows.
drop policy if exists "user can select own transactions" on portfolio_transactions;
create policy "user can select own transactions" on portfolio_transactions
  for select
  using (auth.uid() = user_id);

drop policy if exists "user can insert own transactions" on portfolio_transactions;
create policy "user can insert own transactions" on portfolio_transactions
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user can update own transactions" on portfolio_transactions;
create policy "user can update own transactions" on portfolio_transactions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user can delete own transactions" on portfolio_transactions;
create policy "user can delete own transactions" on portfolio_transactions
  for delete
  using (auth.uid() = user_id);

-- Household access: ADDITIONAL permissive policies alongside the per-user ones
-- above -- Postgres OR's permissive policies together, so a household member
-- can also reach the rows keyed by household_id.
drop policy if exists "household member can select transactions" on portfolio_transactions;
create policy "household member can select transactions" on portfolio_transactions
  for select
  using (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can insert transactions" on portfolio_transactions;
create policy "household member can insert transactions" on portfolio_transactions
  for insert
  with check (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can update transactions" on portfolio_transactions;
create policy "household member can update transactions" on portfolio_transactions
  for update
  using (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  )
  with check (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can delete transactions" on portfolio_transactions;
create policy "household member can delete transactions" on portfolio_transactions
  for delete
  using (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

-- Marks a portfolio whose transactions now live in the table above. Until this
-- is true for a row, the app reads that row's `portfolio.transactions` blob;
-- once it is, the blob's transaction list is ignored and left empty.
alter table portfolios add column if not exists transactions_migrated boolean not null default false;
