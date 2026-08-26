-- Cloud sync for the portfolio tracker, mirroring how `plans` already works
-- for the forecast tool (see household_linking.sql for that table's
-- household-sharing policies, which this mirrors from the start instead of
-- bolting on later).
--
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (every statement is
-- idempotent).

create table if not exists portfolios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid references households(id),
  portfolio jsonb not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists portfolios_household_id_key on portfolios (household_id);

alter table portfolios enable row level security;

-- Per-user access: a signed-in user can read/write their own row.
drop policy if exists "user can select own portfolio" on portfolios;
create policy "user can select own portfolio" on portfolios
  for select
  using (auth.uid() = user_id);

drop policy if exists "user can insert own portfolio" on portfolios;
create policy "user can insert own portfolio" on portfolios
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user can update own portfolio" on portfolios;
create policy "user can update own portfolio" on portfolios
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Household access: these are ADDITIONAL permissive policies alongside the
-- per-user ones above -- Postgres OR's permissive policies together, so a
-- household member can also reach the shared row keyed by household_id.
drop policy if exists "household member can select portfolio" on portfolios;
create policy "household member can select portfolio" on portfolios
  for select
  using (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can insert portfolio" on portfolios;
create policy "household member can insert portfolio" on portfolios
  for insert
  with check (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can update portfolio" on portfolios;
create policy "household member can update portfolio" on portfolios
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
