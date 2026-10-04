-- clean-user-state.sql
-- ---------------------------------------------------------------------------
-- Wipe ALL application state for one account, identified by email.
--
-- Schema: Sutra (api/db/schema.ts) -- public.users keyed by TEXT id.
-- Paste into the Supabase SQL editor (or `psql "$DATABASE_URL_UNPOOLED" -f ...`).
--
-- Why one DELETE is almost enough: every user-owned FK is ON DELETE CASCADE,
-- so dropping the users row removes goals, commitments, milestones, blockers,
-- conversations, messages, proposals, audit_log, sources, memories,
-- timetable_blocks, accounts, sessions, user_sessions, state_overrides,
-- motivation_*, daily_log and plan_rejects.
--
-- The exception is the LangGraph planner checkpoint state
-- (checkpoints / checkpoint_blobs / checkpoint_writes). It is keyed by
-- conversation id (thread_id) with NO FK, so it would be orphaned -- we clear
-- it explicitly first, while the conversation rows still exist.
--
-- Re-runnable and safe: a no-op when the email is not found.
-- ---------------------------------------------------------------------------

-- 1) PREVIEW (optional) -- per-table row counts before deleting. -----------
do $$
declare
  v_uid    text;
  v_table  text;
  v_cnt    bigint;
  v_tables text[] := array[
    'goals','commitments','milestones','blockers','conversations','messages',
    'proposals','audit_log','sources','memories','timetable_blocks','accounts',
    'sessions','user_sessions','state_overrides','motivation_cache',
    'motivation_rejects','motivation_served_log','daily_log','plan_rejects'
  ];
begin
  select id into v_uid from public.users where email = 'agarwaldevanshu8@gmail.com';
  if v_uid is null then
    raise notice 'clean-user-state: no public.users row for that email';
    return;
  end if;
  raise notice 'clean-user-state: user_id = %', v_uid;
  foreach v_table in array v_tables loop
    if to_regclass('public.' || v_table) is not null then
      execute format('select count(*) from public.%I where user_id = $1', v_table)
        into v_cnt using v_uid;
      raise notice '  % : %', v_table, v_cnt;
    end if;
  end loop;
end $$;

-- 2) CLEAN -- delete the planner checkpoints, then cascade the rest. --------
do $$
declare
  v_email   text := 'agarwaldevanshu8@gmail.com';
  v_uid     text;
  v_threads text;
begin
  select id into v_uid from public.users where email = v_email;

  if v_uid is null then
    raise notice 'clean-user-state: no public.users row for % -- nothing to do', v_email;
    return;
  end if;

  raise notice 'clean-user-state: wiping state for % (%)', v_email, v_uid;

  -- Conversation ids are the planner's thread ids. Build a quoted IN-list
  -- before the conversations themselves are cascaded away.
  select string_agg(quote_literal(id), ',') into v_threads
  from public.conversations where user_id = v_uid;

  if v_threads is not null then
    if to_regclass('public.checkpoints') is not null then
      execute 'delete from public.checkpoints where thread_id in (' || v_threads || ')';
    end if;
    if to_regclass('public.checkpoint_blobs') is not null then
      execute 'delete from public.checkpoint_blobs where thread_id in (' || v_threads || ')';
    end if;
    if to_regclass('public.checkpoint_writes') is not null then
      execute 'delete from public.checkpoint_writes where thread_id in (' || v_threads || ')';
    end if;
  end if;

  -- Everything else cascades from users.
  delete from public.users where id = v_uid;

  raise notice 'clean-user-state: done (user % removed)', v_uid;
end $$;

-- 3) POST-CHECK -- should return 0 rows. ------------------------------------
-- select id, email from public.users where email = 'agarwaldevanshu8@gmail.com';

-- NOTE -- legacy Supabase Auth row (only if this account ever signed in
-- through Supabase Auth before the Emergent switch). Uncomment if needed;
-- runs as the SQL-editor owner, which can touch the auth schema.
-- delete from auth.users where email = 'agarwaldevanshu8@gmail.com';

-- NOTE -- object storage (Emergent): deleting sources/memories rows leaves
-- any uploaded files in the bucket. There is no DB link to them; purge the
-- bucket separately only if you want the bytes gone too.
