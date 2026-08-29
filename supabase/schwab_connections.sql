-- Per-user Schwab connections.
--
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (every statement is
-- idempotent), and safe to run over the earlier version of this table.
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
  --
  -- Nullable: a row exists as soon as someone registers their own Schwab
  -- application, which is before they have ever connected, and it outlives
  -- every disconnect after that.
  refresh_token text,

  -- When Schwab issued it. The seven-day expiry is measured from here, and it
  -- cannot be renewed without the user logging in again.
  obtained_at timestamptz,

  -- The user's own Schwab application, encrypted like the token.
  --
  -- Schwab has no multi-tenant integration model: every OAuth flow runs
  -- against one registered application, and Schwab holds its owner responsible
  -- for the traffic. So a second person cannot be added to a deployment by
  -- inviting them -- only by letting them register their own app and store it
  -- here. Null means this user falls back to the deployment's own credentials,
  -- which only happens where the operator has opted into lending them out.
  app_key text,
  app_secret text,

  updated_at timestamptz not null default now()
);

-- Bring an existing table up to the shape above. Each of these is a no-op on a
-- table that already matches.
alter table schwab_connections add column if not exists app_key text;
alter table schwab_connections add column if not exists app_secret text;
alter table schwab_connections alter column refresh_token drop not null;
alter table schwab_connections alter column obtained_at drop not null;

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

-- Belt and braces against the one mistake that would undo all of the above:
-- a future migration, or a hand-run statement, leaving RLS off on this table.
-- Postgres has no "assert" here, so this raises loudly at migration time
-- instead of failing silently in production.
do $$
begin
  if not (
    select relrowsecurity from pg_class where oid = 'public.schwab_connections'::regclass
  ) then
    raise exception 'schwab_connections has row-level security disabled -- refusing to leave brokerage credentials readable across accounts';
  end if;
end $$;
