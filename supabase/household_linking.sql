-- Links Skylar & Hirva's two Google accounts to one shared plan.
--
-- Run this once in the Supabase dashboard: Project -> SQL Editor -> New query
-- -> paste this whole file -> Run. Safe to re-run (every statement is
-- idempotent) except the "seed the household" block at the bottom, which
-- only inserts if a household for these two emails doesn't already exist.

create extension if not exists pgcrypto;

-- One household. In principle more than two people could join it, but this
-- app only ever expects Skylar and Hirva.
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- Which emails belong to which household. The app looks a signed-in user's
-- email up here to find the shared plan row.
create table if not exists household_members (
  household_id uuid not null references households(id) on delete cascade,
  email text not null,
  primary key (household_id, email)
);

alter table household_members enable row level security;

drop policy if exists "member can view own household membership" on household_members;
create policy "member can view own household membership" on household_members
  for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

-- Add household_id to the existing plans table. Rows stay keyed by user_id
-- for anyone not in a household; paired users share one row keyed by
-- household_id instead.
alter table plans add column if not exists household_id uuid references households(id);

create unique index if not exists plans_household_id_key on plans (household_id);

alter table plans enable row level security;

-- These are ADDITIONAL permissive policies alongside whatever per-user
-- policies already exist on `plans` -- Postgres OR's permissive policies
-- together, so this only ever grants extra access (to a household member's
-- shared row), never removes the existing per-user access.
drop policy if exists "household member can select plan" on plans;
create policy "household member can select plan" on plans
  for select
  using (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can insert plan" on plans;
create policy "household member can insert plan" on plans
  for insert
  with check (
    household_id in (
      select household_id from household_members
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "household member can update plan" on plans;
create policy "household member can update plan" on plans
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

-- Seed the household for Skylar & Hirva, and link it to whichever existing
-- plan row belongs to either of them so no data is lost.
do $$
declare
  new_household_id uuid;
  existing_uid uuid;
begin
  if exists (
    select 1 from household_members
    where email in ('hirvas19@gmail.com', 'skylarts@gmail.com')
  ) then
    raise notice 'Household already seeded for these emails -- skipping.';
    return;
  end if;

  insert into households default values returning id into new_household_id;

  insert into household_members (household_id, email) values
    (new_household_id, 'hirvas19@gmail.com'),
    (new_household_id, 'skylarts@gmail.com');

  select p.user_id into existing_uid
  from plans p
  join auth.users u on u.id = p.user_id
  where lower(u.email) in ('hirvas19@gmail.com', 'skylarts@gmail.com')
  order by p.updated_at desc
  limit 1;

  if existing_uid is not null then
    update plans set household_id = new_household_id where user_id = existing_uid;
  end if;
end $$;
