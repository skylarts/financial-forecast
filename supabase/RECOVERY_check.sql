-- RECOVERY: find out whether the transactions still exist in Supabase.
--
-- Run these in the Supabase dashboard: Project -> SQL Editor -> New query.
-- These are all READ-ONLY. Nothing here changes or deletes anything.
--
-- Run them one at a time and keep the output.

-- =====================================================================
-- 1. Are the transaction rows still there, and who do they belong to?
--
-- This is the important one. The sync wrote rows keyed by `scope_id`, and
-- the read looked for a *different* scope_id, found nothing, and treated
-- "nothing" as "this ledger is empty". If the rows were written at all,
-- they are still sitting here.
-- =====================================================================
select
  scope_id,
  user_id,
  household_id,
  count(*)                        as transaction_count,
  min(data->>'date')              as earliest,
  max(data->>'date')              as latest,
  count(distinct data->>'accountId') as accounts_covered
from portfolio_transactions
group by scope_id, user_id, household_id
order by transaction_count desc;


-- =====================================================================
-- 2. What does the portfolio blob hold now, and when was it last written?
--
-- `blob_transaction_count` will be 0 for any portfolio the new sync has
-- touched -- that is the copy it deliberately emptied. `updated_at` tells
-- you when that happened.
-- =====================================================================
select
  user_id,
  household_id,
  transactions_migrated,
  jsonb_array_length(portfolio->'transactions') as blob_transaction_count,
  jsonb_array_length(portfolio->'accounts')     as blob_account_count,
  updated_at
from portfolios;


-- =====================================================================
-- 3. Per-account breakdown of what survives, so you can see exactly which
--    accounts still have history and which are empty.
-- =====================================================================
select
  data->>'accountId' as account_id,
  count(*)           as transaction_count,
  min(data->>'date') as earliest,
  max(data->>'date') as latest
from portfolio_transactions
group by data->>'accountId'
order by transaction_count desc;


-- =====================================================================
-- 4. EXPORT -- run this once you know from query 1 which scope_id holds
--    the data. Replace the placeholder, run it, then click the cell in
--    the result and copy the whole JSON array.
--
--    That array is a drop-in replacement for the "transactions": [ ... ]
--    section of a portfolio backup file.
-- =====================================================================
-- select jsonb_pretty(jsonb_agg(data order by data->>'date'))
-- from portfolio_transactions
-- where scope_id = 'PASTE_THE_SCOPE_ID_FROM_QUERY_1';
