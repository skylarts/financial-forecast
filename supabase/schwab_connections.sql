-- Per-user Schwab connections.
--
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (every statement is
-- idempotent).
--
-- Deliberately unlike `portfolios`: there are NO household policies here.
-- A household member can already see the portfolio this credential feeds, and
-- that is the right amount of sharing. The credential itself is a live key to
-- someone's brokerage -- Schwab issues no read-only variant, so anyone holding
-- it could in principle trade -- and it stays readable by exactly one person.
-- Sharing the numbers is not the same as sharing the key that produces them.

create table if not exists schwab_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Encrypted before it ever reaches this column; see `schwabCrypto`. The
  -- database is not trusted with the plaintext, so a dump or a leaked backup
  -- is not by itself a usable brokerage credential.
  refresh_token text not null,

  -- When Schwab issued it. The seven-day expiry is measured from here, and it
  -- cannot be renewed without the user logging in again.
  obtained_at timestamptz not null,

  -- Reserved for the bring-your-own-app model, where each user registers their
  -- own Schwab application rather than sharing one. Encrypted like the token.
  -- Null means the deployment's own app credentials are used.
  app_key text,
  app_secret text,

  updated_at timestamptz not null default now()
);

alter table schwab_connections enable row level security;

-- One person, one row, no exceptions. Row-level security is what makes a bug
-- in the application layer non-fatal: even a route that forgot to scope its
-- query cannot return someone else's credential.
drop policy if exists "user can select own schwab connection" on schwab_connections;
create policy "user can select own schwab connection" on schwab_connections
  for select
  using (auth.uid() = user_id);

drop policy if exists "user can insert own schwab connection" on schwab_connections;
create policy "user can insert own schwab connection" on schwab_connections
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user can update own schwab connection" on schwab_connections;
create policy "user can update own schwab connection" on schwab_connections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user can delete own schwab connection" on schwab_connections;
create policy "user can delete own schwab connection" on schwab_connections
  for delete
  using (auth.uid() = user_id);
