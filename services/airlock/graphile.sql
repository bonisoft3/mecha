-- Written by `task generate:graphile` (graphile_sql.ts) from graphile-worker 0.18.0; do not edit.
begin;
create schema if not exists "graphile_worker";
create table if not exists "graphile_worker".migrations(
  id int primary key,
  ts timestamptz default now() not null
);
alter table "graphile_worker".migrations add column if not exists breaking boolean not null default false;
-- 000001.sql
insert into "graphile_worker".migrations (id, breaking) values (1, true);
--! breaking-change
-- Create the tables
create table "graphile_worker".job_queues (
  queue_name text not null primary key,
  job_count int not null,
  locked_at timestamptz,
  locked_by text
);
alter table "graphile_worker".job_queues enable row level security;

create table "graphile_worker".jobs (
  id bigserial primary key,
  queue_name text not null,
  task_identifier text not null,
  payload json default '{}'::json not null,
  priority int default 0 not null,
  run_at timestamptz default now() not null,
  attempts int default 0 not null,
  max_attempts int default 25 not null,
  last_error text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);
alter table "graphile_worker".jobs enable row level security;

create index on "graphile_worker".jobs (priority, run_at, id);

-- Keep updated_at up to date
create function "graphile_worker".tg__update_timestamp() returns trigger as $$
begin
  new.updated_at = greatest(now(), old.updated_at + interval '1 millisecond');
  return new;
end;
$$ language plpgsql;
create trigger _100_timestamps before update on "graphile_worker".jobs for each row execute procedure "graphile_worker".tg__update_timestamp();

-- Manage the job_queues table - creating and deleting entries as appropriate
create function "graphile_worker".jobs__decrease_job_queue_count() returns trigger as $$
declare
  v_new_job_count int;
begin
  update "graphile_worker".job_queues
    set job_count = job_queues.job_count - 1
    where queue_name = old.queue_name
    returning job_count into v_new_job_count;

  if v_new_job_count <= 0 then
    delete from "graphile_worker".job_queues where queue_name = old.queue_name and job_count <= 0;
  end if;

  return old;
end;
$$ language plpgsql;
create function "graphile_worker".jobs__increase_job_queue_count() returns trigger as $$
begin
  insert into "graphile_worker".job_queues(queue_name, job_count)
    values(new.queue_name, 1)
    on conflict (queue_name)
    do update
    set job_count = job_queues.job_count + 1;

  return new;
end;
$$ language plpgsql;
create trigger _500_increase_job_queue_count after insert on "graphile_worker".jobs for each row execute procedure "graphile_worker".jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count after delete on "graphile_worker".jobs for each row execute procedure "graphile_worker".jobs__decrease_job_queue_count();
create trigger _500_increase_job_queue_count_update after update of queue_name on "graphile_worker".jobs for each row execute procedure "graphile_worker".jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count_update after update of queue_name on "graphile_worker".jobs for each row execute procedure "graphile_worker".jobs__decrease_job_queue_count();

-- Notify worker of new jobs
create function "graphile_worker".tg_jobs__notify_new_jobs() returns trigger as $$
begin
  perform pg_notify('jobs:insert', '');
  return new;
end;
$$ language plpgsql;
create trigger _900_notify_worker after insert on "graphile_worker".jobs for each statement execute procedure "graphile_worker".tg_jobs__notify_new_jobs();

-- Function to queue a job
create function "graphile_worker".add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null, -- was gen_random_uuid(), but later removed dependency
  run_at timestamptz = now(),
  max_attempts int = 25
) returns "graphile_worker".jobs as $$
  insert into "graphile_worker".jobs(task_identifier, payload, queue_name, run_at, max_attempts) values(identifier, payload, queue_name, run_at, max_attempts) returning *;
$$ language sql;

-- The main function - find me a job to do!
create function "graphile_worker".get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns "graphile_worker".jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_default_job_max_attempts text = '25';
  v_row "graphile_worker".jobs;
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select job_queues.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    inner join "graphile_worker".job_queues using (queue_name)
    where (locked_at is null or locked_at < (now() - job_expiry))
    and run_at <= now()
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update of job_queues
    skip locked;

  if v_queue_name is null then
    return null;
  end if;

  update "graphile_worker".job_queues
    set
      locked_by = worker_id,
      locked_at = now()
    where job_queues.queue_name = v_queue_name;

  update "graphile_worker".jobs
    set attempts = attempts + 1
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql;

-- I was successful, mark the job as completed
create function "graphile_worker".complete_job(worker_id text, job_id bigint) returns "graphile_worker".jobs as $$
declare
  v_row "graphile_worker".jobs;
begin
  delete from "graphile_worker".jobs
    where id = job_id
    returning * into v_row;

  update "graphile_worker".job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql;

-- I was unsuccessful, re-schedule the job please
create function "graphile_worker".fail_job(worker_id text, job_id bigint, error_message text) returns "graphile_worker".jobs as $$
declare
  v_row "graphile_worker".jobs;
begin
  update "graphile_worker".jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval
    where id = job_id
    returning * into v_row;

  update "graphile_worker".job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql;
-- 000002.sql
insert into "graphile_worker".migrations (id, breaking) values (2, false);
alter table "graphile_worker".jobs add column key text unique check(length(key) > 0);

alter table "graphile_worker".jobs add locked_at timestamptz;
alter table "graphile_worker".jobs add locked_by text;

-- update any in-flight jobs
update "graphile_worker".jobs
  set locked_at = q.locked_at, locked_by = q.locked_by
  from "graphile_worker".job_queues q
  where q.queue_name = jobs.queue_name
  and q.locked_at is not null;

-- update add_job behaviour to meet new requirements
drop function if exists "graphile_worker".add_job(
  identifier text,
  payload json,
  queue_name text,
  run_at timestamptz,
  max_attempts int
);
create function "graphile_worker".add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null,
  run_at timestamptz = now(),
  max_attempts int = 25,
  job_key text = null
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  if job_key is not null then
    -- Upsert job
    insert into "graphile_worker".jobs (task_identifier, payload, queue_name, run_at, max_attempts, key)
      values(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key
      )
      on conflict (key) do update set
        -- update all job details other than queue_name, which we want to keep
        -- the same unless explicitly provided
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=coalesce(add_job.queue_name, jobs.queue_name),
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(task_identifier, payload, queue_name, run_at, max_attempts, key)
    values(
      identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      job_key
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

--- implement new remove_job function

create function "graphile_worker".remove_job(
  job_key text
) returns "graphile_worker".jobs as $$
  delete from "graphile_worker".jobs
    where key = job_key
    and locked_at is null
  returning *;
$$ language sql strict volatile;

-- Update other functions to handle locked_at denormalisation

create or replace function "graphile_worker".get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns "graphile_worker".jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row "graphile_worker".jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select job_queues.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    inner join "graphile_worker".job_queues using (queue_name)
    where (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update of job_queues
    skip locked;

  if v_queue_name is null then
    return null;
  end if;

  update "graphile_worker".job_queues
    set
      locked_by = worker_id,
      locked_at = v_now
    where job_queues.queue_name = v_queue_name;

  update "graphile_worker".jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;

-- I was unsuccessful, re-schedule the job please
create or replace function "graphile_worker".fail_job(worker_id text, job_id bigint, error_message text) returns "graphile_worker".jobs as $$
declare
  v_row "graphile_worker".jobs;
begin
  update "graphile_worker".jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval,
      locked_by = null,
      locked_at = null
    where id = job_id and locked_by = worker_id
    returning * into v_row;

  update "graphile_worker".job_queues
    set locked_by = null, locked_at = null
    where queue_name = v_row.queue_name and locked_by = worker_id;

  return v_row;
end;
$$ language plpgsql volatile strict;
-- 000003.sql
insert into "graphile_worker".migrations (id, breaking) values (3, true);
--! breaking-change
alter table "graphile_worker".jobs alter column queue_name drop not null;

create or replace function "graphile_worker".add_job(
  identifier text,
  payload json = '{}',
  queue_name text = null,
  run_at timestamptz = now(),
  max_attempts int = 25,
  job_key text = null
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  if job_key is not null then
    -- Upsert job
    insert into "graphile_worker".jobs (task_identifier, payload, queue_name, run_at, max_attempts, key)
      values(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(task_identifier, payload, queue_name, run_at, max_attempts, key)
    values(
      identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      job_key
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

create or replace function "graphile_worker".get_job(worker_id text, task_identifiers text[] = null, job_expiry interval = interval '4 hours') returns "graphile_worker".jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row "graphile_worker".jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    where (jobs.locked_at is null or jobs.locked_at < (v_now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from "graphile_worker".job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update "graphile_worker".job_queues
      set
        locked_by = worker_id,
        locked_at = v_now
      where job_queues.queue_name = v_queue_name;
  end if;

  update "graphile_worker".jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;

create or replace function "graphile_worker".fail_job(worker_id text, job_id bigint, error_message text) returns "graphile_worker".jobs as $$
declare
  v_row "graphile_worker".jobs;
begin
  update "graphile_worker".jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval,
      locked_by = null,
      locked_at = null
    where id = job_id and locked_by = worker_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update "graphile_worker".job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$ language plpgsql volatile strict;

create or replace function "graphile_worker".complete_job(worker_id text, job_id bigint) returns "graphile_worker".jobs as $$
declare
  v_row "graphile_worker".jobs;
begin
  delete from "graphile_worker".jobs
    where id = job_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update "graphile_worker".job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$ language plpgsql;

drop trigger _500_increase_job_queue_count on "graphile_worker".jobs;
drop trigger _500_decrease_job_queue_count on "graphile_worker".jobs;
drop trigger _500_increase_job_queue_count_update on "graphile_worker".jobs;
drop trigger _500_decrease_job_queue_count_update on "graphile_worker".jobs;
create trigger _500_increase_job_queue_count after insert on "graphile_worker".jobs for each row when (NEW.queue_name is not null) execute procedure "graphile_worker".jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count after delete on "graphile_worker".jobs for each row when (OLD.queue_name is not null) execute procedure "graphile_worker".jobs__decrease_job_queue_count();
create trigger _500_increase_job_queue_count_update after update of queue_name on "graphile_worker".jobs for each row when (NEW.queue_name is distinct from OLD.queue_name AND NEW.queue_name is not null) execute procedure "graphile_worker".jobs__increase_job_queue_count();
create trigger _500_decrease_job_queue_count_update after update of queue_name on "graphile_worker".jobs for each row when (NEW.queue_name is distinct from OLD.queue_name AND OLD.queue_name is not null) execute procedure "graphile_worker".jobs__decrease_job_queue_count();
-- 000004.sql
insert into "graphile_worker".migrations (id, breaking) values (4, false);
drop function "graphile_worker".add_job(text, json, text, timestamptz, int, text);

create function "graphile_worker".add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts int = null,
  job_key text = null,
  priority int = null
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1' using errcode = 'GWBMA';
  end if;

  if job_key is not null then
    -- Upsert job
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0)
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,
        priority=excluded.priority,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0)
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

create function "graphile_worker".complete_jobs(
  job_ids bigint[]
) returns setof "graphile_worker".jobs as $$
  delete from "graphile_worker".jobs
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;

create function "graphile_worker".permanently_fail_jobs(
  job_ids bigint[],
  error_message text = null
) returns setof "graphile_worker".jobs as $$
  update "graphile_worker".jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;

create function "graphile_worker".reschedule_jobs(
  job_ids bigint[],
  run_at timestamptz = null,
  priority int = null,
  attempts int = null,
  max_attempts int = null
) returns setof "graphile_worker".jobs as $$
  update "graphile_worker".jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts)
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql volatile;
-- 000005.sql
insert into "graphile_worker".migrations (id, breaking) values (5, false);
alter table "graphile_worker".jobs add column revision int default 0 not null;
alter table "graphile_worker".jobs add column flags jsonb default null;

drop function "graphile_worker".add_job(text, json, text, timestamptz, int, text, int);
create function "graphile_worker".add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts int = null,
  job_key text = null,
  priority int = null,
  flags text[] = null
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1' using errcode = 'GWBMA';
  end if;

  if job_key is not null then
    -- Upsert job
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=excluded.run_at,
        priority=excluded.priority,
        revision=jobs.revision + 1,
        flags=excluded.flags,

        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;

    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;

    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries by bumping attempts to the max allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  end if;

  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(flags) as item(flag)
      )
    )
    returning *
    into v_job;

  return v_job;
end;
$$ language plpgsql volatile;

drop function "graphile_worker".get_job(text, text[], interval);
create function "graphile_worker".get_job(
  worker_id text,
  task_identifiers text[] = null,
  job_expiry interval = interval '4 hours',
  forbidden_flags text[] = null
) returns "graphile_worker".jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row "graphile_worker".jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    where (jobs.locked_at is null or jobs.locked_at < (v_now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from "graphile_worker".job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    and (forbidden_flags is null or (flags ?| forbidden_flags) is not true)
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update "graphile_worker".job_queues
      set
        locked_by = worker_id,
        locked_at = v_now
      where job_queues.queue_name = v_queue_name;
  end if;

  update "graphile_worker".jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;
-- 000006.sql
insert into "graphile_worker".migrations (id, breaking) values (6, false);
create index jobs_priority_run_at_id_locked_at_without_failures_idx
  on "graphile_worker".jobs (priority, run_at, id, locked_at)
  where attempts < max_attempts;

drop index "graphile_worker".jobs_priority_run_at_id_idx;
-- 000007.sql
insert into "graphile_worker".migrations (id, breaking) values (7, false);
drop function "graphile_worker".add_job(text, json, text, timestamptz, int, text, int, text[]);
create function "graphile_worker".add_job(
  identifier text,
  payload json = null,
  queue_name text = null,
  run_at timestamptz = null,
  max_attempts integer = null,
  job_key text = null,
  priority integer = null,
  flags text[] = null,
  job_key_mode text = 'replace'
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1.' using errcode = 'GWBMA';
  end if;
  if job_key is not null and (job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    -- Upsert job if existing job isn't locked, but in the case of locked
    -- existing job create a new job instead as it must have already started
    -- executing (i.e. it's world state is out of date, and the fact add_job
    -- has been called again implies there's new information that needs to be
    -- acted upon).
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=(case
          when job_key_mode = 'preserve_run_at' and jobs.attempts = 0 then jobs.run_at
          else excluded.run_at
        end),
        priority=excluded.priority,
        revision=jobs.revision + 1,
        flags=excluded.flags,
        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;
    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;
    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries of existing job by bumping attempts to the max
    -- allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  elsif job_key is not null and job_key_mode = 'unsafe_dedupe' then
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key)
      -- Bump the revision so that there's something to return
      do update set revision = jobs.revision + 1
      returning *
      into v_job;
    return v_job;
  elsif job_key is not null then
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(flags) as item(flag)
      )
    )
    returning *
    into v_job;
  return v_job;
end;
$$ language plpgsql volatile;

create or replace function "graphile_worker".remove_job(job_key text)
returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker".jobs
    where key = job_key
    and locked_at is null
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker".jobs
    set attempts = max_attempts, key = null
    where key = job_key
  returning * into v_job;
  return v_job;
end;
$$ language plpgsql strict;
-- 000008.sql
insert into "graphile_worker".migrations (id, breaking) values (8, false);
create table "graphile_worker".known_crontabs (
  identifier text not null primary key,
  known_since timestamptz not null,
  last_execution timestamptz
);
alter table "graphile_worker".known_crontabs enable row level security;
-- 000009.sql
insert into "graphile_worker".migrations (id, breaking) values (9, false);
drop function "graphile_worker".get_job(text, text[], interval, text[]);
create function "graphile_worker".get_job(
  worker_id text,
  task_identifiers text[] = null,
  job_expiry interval = interval '4 hours',
  forbidden_flags text[] = null,
  now timestamptz = now()
) returns "graphile_worker".jobs as $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row "graphile_worker".jobs;
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    where (jobs.locked_at is null or jobs.locked_at < (now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from "graphile_worker".job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    and (forbidden_flags is null or (flags ?| forbidden_flags) is not true)
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update "graphile_worker".job_queues
      set
        locked_by = worker_id,
        locked_at = now
      where job_queues.queue_name = v_queue_name;
  end if;

  update "graphile_worker".jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$ language plpgsql volatile;
-- 000010.sql
insert into "graphile_worker".migrations (id, breaking) values (10, false);
alter table "graphile_worker".jobs alter column queue_name drop default;
-- 000011.sql
insert into "graphile_worker".migrations (id, breaking) values (11, true);
--! breaking-change
lock table "graphile_worker".jobs;
lock table "graphile_worker".job_queues;

-- If there's any locked jobs, abort via division by zero
select 1/(case when exists (
  select 1
  from "graphile_worker".jobs
  where locked_at is not null
  and locked_at > NOW() - interval '4 hours'
) then 0 else 1 end);

alter table "graphile_worker".jobs
alter column attempts type int2,
alter column max_attempts type int2,
alter column priority type int2;


drop function "graphile_worker".complete_job;
drop function "graphile_worker".fail_job;
drop function "graphile_worker".get_job;



drop trigger _900_notify_worker on "graphile_worker".jobs;
drop function "graphile_worker".add_job;
drop function "graphile_worker".complete_jobs;
drop function "graphile_worker".permanently_fail_jobs;
drop function "graphile_worker".remove_job;
drop function "graphile_worker".reschedule_jobs;
drop function "graphile_worker".tg_jobs__notify_new_jobs;
alter table "graphile_worker".jobs rename to jobs_legacy;
alter table "graphile_worker".job_queues rename to job_queues_legacy;

create table "graphile_worker".job_queues (
  id int primary key generated always as identity,
  queue_name text not null unique check (length(queue_name) <= 128),
  locked_at timestamptz,
  locked_by text,
  is_available boolean generated always as ((locked_at is null)) stored not null
);
alter table "graphile_worker".job_queues enable row level security;

create table "graphile_worker".tasks (
  id int primary key generated always as identity,
  identifier text not null unique check (length(identifier) <= 128)
);
alter table "graphile_worker".tasks enable row level security;

create table "graphile_worker".jobs (
  id bigint primary key generated always as identity,
  job_queue_id int null, -- not adding 'references' to eke out more performance
  task_id int not null,
  payload json default '{}'::json not null,
  priority smallint default 0 not null,
  run_at timestamptz default now() not null,
  attempts smallint default 0 not null,
  max_attempts smallint default 25 not null constraint jobs_max_attempts_check check (max_attempts >= 1),
  last_error text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  key text unique constraint jobs_key_check check (length(key) > 0 and length(key) <= 512),
  locked_at timestamptz,
  locked_by text,
  revision integer default 0 not null,
  flags jsonb,
  is_available boolean generated always as (((locked_at is null) and (attempts < max_attempts))) stored not null
);
alter table "graphile_worker".jobs enable row level security;

create index jobs_main_index
  on "graphile_worker".jobs
  using btree (priority, run_at)
  include (id, task_id, job_queue_id)
  where (is_available = true);

create index jobs_no_queue_index
  on "graphile_worker".jobs
  using btree (priority, run_at)
  include (id, task_id)
  where (is_available = true and job_queue_id is null);

create type "graphile_worker".job_spec as (
  identifier text,
  payload json,
  queue_name text,
  run_at timestamptz,
  max_attempts integer,
  job_key text,
  priority integer,
  flags text[]
);

create function "graphile_worker".add_jobs(
  specs "graphile_worker".job_spec[],
  job_key_preserve_run_at boolean default false
)
returns setof "graphile_worker".jobs
as $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker".tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;

  -- Ensure all the queues exist
  insert into "graphile_worker".job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;

  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker".jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?

  return query insert into "graphile_worker".jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker".tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker".job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload = excluded.payload,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$ language plpgsql;

create function "graphile_worker".complete_jobs(job_ids bigint[])
returns setof "graphile_worker".jobs
as $$
  delete from "graphile_worker".jobs
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < now() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function "graphile_worker".permanently_fail_jobs(
  job_ids bigint[],
  error_message text default null::text
)
returns setof "graphile_worker".jobs
as $$
  update "graphile_worker".jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts,
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function "graphile_worker".remove_job(job_key text)
returns "graphile_worker".jobs
as $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker".jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker".jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$ language plpgsql strict;

create function "graphile_worker".reschedule_jobs(
  job_ids bigint[],
  run_at timestamp with time zone default null::timestamp with time zone,
  priority integer default null::integer,
  attempts integer default null::integer,
  max_attempts integer default null::integer
) returns setof "graphile_worker".jobs
as $$
  update "graphile_worker".jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$ language sql;

create function "graphile_worker".tg_jobs__after_insert() returns trigger
as $$
begin
  perform pg_notify('jobs:insert', '');
  return new;
end;
$$ language plpgsql;
create trigger _900_after_insert
after insert on "graphile_worker".jobs
for each statement
execute procedure "graphile_worker".tg_jobs__after_insert();

create function "graphile_worker".add_job(
  identifier text,
  payload json default null::json,
  queue_name text default null::text,
  run_at timestamp with time zone default null::timestamp with time zone,
  max_attempts integer default null::integer,
  job_key text default null::text,
  priority integer default null::integer,
  flags text[] default null::text[],
  job_key_mode text default 'replace'::text
) returns "graphile_worker".jobs as $$
declare
  v_job "graphile_worker".jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key,
        priority,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker".tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;

    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker".job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;

    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker".jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts, 25),
        add_job.job_key,
        coalesce(add_job.priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker".tasks
      left join "graphile_worker".job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$ language plpgsql;

-- Migrate over the old tables
insert into "graphile_worker".job_queues (queue_name)
select distinct queue_name
from "graphile_worker".jobs_legacy
where queue_name is not null
on conflict do nothing;

insert into "graphile_worker".tasks (identifier)
select distinct task_identifier
from "graphile_worker".jobs_legacy
on conflict do nothing;

insert into "graphile_worker".jobs (
  job_queue_id,
  task_id,
  payload,
  priority,
  run_at,
  attempts,
  max_attempts,
  last_error,
  created_at,
  updated_at,
  key,
  revision,
  flags
)
  select
    job_queues.id,
    tasks.id,
    legacy.payload,
    legacy.priority,
    legacy.run_at,
    legacy.attempts,
    legacy.max_attempts,
    legacy.last_error,
    legacy.created_at,
    legacy.updated_at,
    legacy.key,
    legacy.revision,
    legacy.flags
  from "graphile_worker".jobs_legacy legacy
  inner join "graphile_worker".tasks
  on tasks.identifier = legacy.task_identifier
  left join "graphile_worker".job_queues
  on job_queues.queue_name = legacy.queue_name;

drop table "graphile_worker".jobs_legacy;
drop table "graphile_worker".job_queues_legacy;
-- 000012.sql
insert into "graphile_worker".migrations (id, breaking) values (12, false);
create or replace function "graphile_worker".add_jobs(
  specs "graphile_worker".job_spec[],
  job_key_preserve_run_at boolean default false
)
returns setof "graphile_worker".jobs
as $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker".tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;

  -- Ensure all the queues exist
  insert into "graphile_worker".job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;

  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker".jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?

  return query insert into "graphile_worker".jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker".tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker".job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$ language plpgsql;
-- 000013.sql
insert into "graphile_worker".migrations (id, breaking) values (13, true);
--! breaking-change
alter type "graphile_worker".job_spec alter attribute max_attempts type smallint;
alter type "graphile_worker".job_spec alter attribute priority type smallint;

drop function "graphile_worker".add_job;
CREATE FUNCTION "graphile_worker".add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts smallint DEFAULT NULL::smallint, job_key text DEFAULT NULL::text, priority smallint DEFAULT NULL::smallint, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS "graphile_worker".jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker".jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts,
        job_key,
        priority,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker".tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker".job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker".jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts, 25),
        add_job.job_key,
        coalesce(add_job.priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker".tasks
      left join "graphile_worker".job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

DROP FUNCTION "graphile_worker".reschedule_jobs;
CREATE FUNCTION "graphile_worker".reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority smallint DEFAULT NULL::smallint, attempts smallint DEFAULT NULL::smallint, max_attempts smallint DEFAULT NULL::smallint) RETURNS SETOF "graphile_worker".jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker".jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;
-- 000014.sql
insert into "graphile_worker".migrations (id, breaking) values (14, true);
--! breaking-change
-- Go back to exposing 'int' on public interfaces, use smallint internally.

drop function "graphile_worker".add_job;
CREATE FUNCTION "graphile_worker".add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts int DEFAULT NULL::int, job_key text DEFAULT NULL::text, priority int DEFAULT NULL::int, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS "graphile_worker".jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker".jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker".tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker".job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker".jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker".tasks
      left join "graphile_worker".job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

DROP FUNCTION "graphile_worker".reschedule_jobs;
CREATE FUNCTION "graphile_worker".reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority int DEFAULT NULL::int, attempts int DEFAULT NULL::int, max_attempts int DEFAULT NULL::int) RETURNS SETOF "graphile_worker".jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker".jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority::smallint, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts::smallint, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts::smallint, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;
-- 000015.sql
insert into "graphile_worker".migrations (id, breaking) values (15, false);
-- Tidy up from previous migrations
drop function "graphile_worker".jobs__increase_job_queue_count();
drop function "graphile_worker".jobs__decrease_job_queue_count();
drop function "graphile_worker".tg__update_timestamp();

-- Add function to unlock all jobs from the given workers due to a crash or similar
create function "graphile_worker".force_unlock_workers(worker_ids text[]) returns void as $$
update "graphile_worker".jobs
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
update "graphile_worker".job_queues
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
$$ language sql volatile;
-- 000016.sql
insert into "graphile_worker".migrations (id, breaking) values (16, true);
--! breaking-change
alter table "graphile_worker".jobs rename to _private_jobs;
alter table "graphile_worker".job_queues rename to _private_job_queues;
alter table "graphile_worker".tasks rename to _private_tasks;
alter table "graphile_worker".known_crontabs rename to _private_known_crontabs;

DROP FUNCTION "graphile_worker".add_job;
CREATE FUNCTION "graphile_worker".add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker"._private_tasks as tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker"._private_jobs as jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker"._private_tasks as tasks
      left join "graphile_worker"._private_job_queues as job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

DROP FUNCTION "graphile_worker".add_jobs;
CREATE FUNCTION "graphile_worker".add_jobs(specs "graphile_worker".job_spec[], job_key_preserve_run_at boolean DEFAULT false) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker"._private_tasks as tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;
  -- Ensure all the queues exist
  insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;
  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;
  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?
  return query insert into "graphile_worker"._private_jobs as jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker"._private_tasks as tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker"._private_job_queues as job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$;

DROP FUNCTION "graphile_worker".complete_jobs;
CREATE FUNCTION "graphile_worker".complete_jobs(job_ids bigint[]) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE sql
    AS $$
  delete from "graphile_worker"._private_jobs as jobs
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < now() - interval '4 hours'
    )
    returning *;
$$;

DROP FUNCTION "graphile_worker".force_unlock_workers;
CREATE FUNCTION "graphile_worker".force_unlock_workers(worker_ids text[]) RETURNS void
    LANGUAGE sql
    AS $$
update "graphile_worker"._private_jobs as jobs
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
update "graphile_worker"._private_job_queues as job_queues
set locked_at = null, locked_by = null
where locked_by = any(worker_ids);
$$;

DROP FUNCTION "graphile_worker".permanently_fail_jobs;
CREATE FUNCTION "graphile_worker".permanently_fail_jobs(job_ids bigint[], error_message text DEFAULT NULL::text) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts,
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;

DROP FUNCTION "graphile_worker".remove_job;
CREATE FUNCTION "graphile_worker".remove_job(job_key text) RETURNS "graphile_worker"._private_jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker"._private_jobs as jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$;

DROP FUNCTION "graphile_worker".reschedule_jobs;
CREATE FUNCTION "graphile_worker".reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority integer DEFAULT NULL::integer, attempts integer DEFAULT NULL::integer, max_attempts integer DEFAULT NULL::integer) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker"._private_jobs as jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority::smallint, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts::smallint, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts::smallint, jobs.max_attempts),
      updated_at = now()
    where id = any(job_ids)
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;
-- 000017.sql
insert into "graphile_worker".migrations (id, breaking) values (17, false);
create view "graphile_worker".jobs as (
  select
    jobs.id,
    job_queues.queue_name,
    tasks.identifier as task_identifier,
    jobs.priority,
    jobs.run_at,
    jobs.attempts,
    jobs.max_attempts,
    jobs.last_error,
    jobs.created_at,
    jobs.updated_at,
    jobs.key,
    jobs.locked_at,
    jobs.locked_by,
    jobs.revision,
    jobs.flags
  from "graphile_worker"._private_jobs as jobs
  inner join "graphile_worker"._private_tasks as tasks
  on tasks.id = jobs.task_id
  left join "graphile_worker"._private_job_queues as job_queues
  on job_queues.id = jobs.job_queue_id
);
-- 000018.sql
insert into "graphile_worker".migrations (id, breaking) values (18, false);
DROP TRIGGER _900_after_insert ON "graphile_worker"._private_jobs;
DROP FUNCTION "graphile_worker".tg_jobs__after_insert;

CREATE OR REPLACE FUNCTION "graphile_worker".add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist
    insert into "graphile_worker"._private_tasks as tasks (identifier)
    values (add_job.identifier)
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
      values (add_job.queue_name)
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker"._private_jobs as jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker"._private_tasks as tasks
      left join "graphile_worker"._private_job_queues as job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    if v_job.revision = 0 then
      perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":1}');
    end if;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "graphile_worker".add_jobs(specs "graphile_worker".job_spec[], job_key_preserve_run_at boolean DEFAULT false) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
begin
  -- Ensure all the tasks exist
  insert into "graphile_worker"._private_tasks as tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  on conflict do nothing;
  -- Ensure all the queues exist
  insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  on conflict do nothing;
  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- WARNING: this count is not 100% accurate; 'on conflict' clause will cause it to be an overestimate
  perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":' || array_length(specs, 1)::text || '}');

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?
  return query insert into "graphile_worker"._private_jobs as jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker"._private_tasks as tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker"._private_job_queues as job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$;

CREATE OR REPLACE FUNCTION "graphile_worker".remove_job(job_key text) RETURNS "graphile_worker"._private_jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker"._private_jobs as jobs
    where key = job_key
    and (
      locked_at is null
    or
      locked_at < NOW() - interval '4 hours'
    )
  returning * into v_job;
  if not (v_job is null) then
    perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":-1}');
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  where key = job_key
  returning * into v_job;
  return v_job;
end;
$$;
-- 000019.sql
insert into "graphile_worker".migrations (id, breaking) values (19, true);
--! breaking-change
-- This is just a breaking change marker for the v0.17 worker-centric to
-- pool-centric jump. The migration itself is not breaking.
select 1;
-- 000020.sql
insert into "graphile_worker".migrations (id, breaking) values (20, false);
CREATE OR REPLACE FUNCTION "graphile_worker".add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker"._private_jobs;
begin
  if (job_key is null or job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    select * into v_job
    from "graphile_worker".add_jobs(
      ARRAY[(
        identifier,
        payload,
        queue_name,
        run_at,
        max_attempts::smallint,
        job_key,
        priority::smallint,
        flags
      )::"graphile_worker".job_spec],
      (job_key_mode = 'preserve_run_at')
    )
    limit 1;
    return v_job;
  elsif job_key_mode = 'unsafe_dedupe' then
    -- Ensure all the tasks exist (insert only missing identifiers so identity is not consumed)
    insert into "graphile_worker"._private_tasks as tasks (identifier)
    select add_job.identifier
    where not exists (
      select 1
      from "graphile_worker"._private_tasks as existing
      where existing.identifier = add_job.identifier
    )
    on conflict do nothing;
    -- Ensure all the queues exist
    if add_job.queue_name is not null then
      insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
      select add_job.queue_name
      where not exists (
        select 1
        from "graphile_worker"._private_job_queues as existing
        where existing.queue_name = add_job.queue_name
      )
      on conflict do nothing;
    end if;
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker"._private_jobs as jobs (
      job_queue_id,
      task_id,
      payload,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      select
        job_queues.id,
        tasks.id,
        coalesce(add_job.payload, '{}'::json),
        coalesce(add_job.run_at, now()),
        coalesce(add_job.max_attempts::smallint, 25::smallint),
        add_job.job_key,
        coalesce(add_job.priority::smallint, 0::smallint),
        (
          select jsonb_object_agg(flag, true)
          from unnest(add_job.flags) as item(flag)
        )
      from "graphile_worker"._private_tasks as tasks
      left join "graphile_worker"._private_job_queues as job_queues
      on job_queues.queue_name = add_job.queue_name
      where tasks.identifier = add_job.identifier
    on conflict (key)
      -- Bump the updated_at so that there's something to return
      do update set
        revision = jobs.revision + 1,
        updated_at = now()
      returning *
      into v_job;
    if v_job.revision = 0 then
      perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":1}');
    end if;
    return v_job;
  else
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION "graphile_worker".add_jobs(specs "graphile_worker".job_spec[], job_key_preserve_run_at boolean DEFAULT false) RETURNS SETOF "graphile_worker"._private_jobs
    LANGUAGE plpgsql
    AS $$
begin
  -- Ensure all the tasks exist (insert only missing identifiers so identity is not consumed)
  insert into "graphile_worker"._private_tasks as tasks (identifier)
  select distinct spec.identifier
  from unnest(specs) spec
  where not exists (
    select 1
    from "graphile_worker"._private_tasks as existing
    where existing.identifier = spec.identifier
  )
  on conflict do nothing;
  -- Ensure all the queues exist
  insert into "graphile_worker"._private_job_queues as job_queues (queue_name)
  select distinct spec.queue_name
  from unnest(specs) spec
  where spec.queue_name is not null
  and not exists (
    select 1
    from "graphile_worker"._private_job_queues as existing
    where existing.queue_name = spec.queue_name
  )
  on conflict do nothing;
  -- Ensure any locked jobs have their key cleared - in the case of locked
  -- existing job create a new job instead as it must have already started
  -- executing (i.e. it's world state is out of date, and the fact add_job
  -- has been called again implies there's new information that needs to be
  -- acted upon).
  update "graphile_worker"._private_jobs as jobs
  set
    key = null,
    attempts = jobs.max_attempts,
    updated_at = now()
  from unnest(specs) spec
  where spec.job_key is not null
  and jobs.key = spec.job_key
  and is_available is not true;

  -- WARNING: this count is not 100% accurate; 'on conflict' clause will cause it to be an overestimate
  perform pg_notify('jobs:insert', '{"r":' || random()::text || ',"count":' || array_length(specs, 1)::text || '}');

  -- TODO: is there a risk that a conflict could occur depending on the
  -- isolation level?
  return query insert into "graphile_worker"._private_jobs as jobs (
    job_queue_id,
    task_id,
    payload,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    select
      job_queues.id,
      tasks.id,
      coalesce(spec.payload, '{}'::json),
      coalesce(spec.run_at, now()),
      coalesce(spec.max_attempts, 25),
      spec.job_key,
      coalesce(spec.priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(spec.flags) as item(flag)
      )
    from unnest(specs) spec
    inner join "graphile_worker"._private_tasks as tasks
    on tasks.identifier = spec.identifier
    left join "graphile_worker"._private_job_queues as job_queues
    on job_queues.queue_name = spec.queue_name
  on conflict (key) do update set
    job_queue_id = excluded.job_queue_id,
    task_id = excluded.task_id,
    payload =
      case
      when json_typeof(jobs.payload) = 'array' and json_typeof(excluded.payload) = 'array' then
        (jobs.payload::jsonb || excluded.payload::jsonb)::json
      else
        excluded.payload
      end,
    max_attempts = excluded.max_attempts,
    run_at = (case
      when job_key_preserve_run_at is true and jobs.attempts = 0 then jobs.run_at
      else excluded.run_at
    end),
    priority = excluded.priority,
    revision = jobs.revision + 1,
    flags = excluded.flags,
    -- always reset error/retry state
    attempts = 0,
    last_error = null,
    updated_at = now()
  where jobs.locked_at is null
  returning *;
end;
$$;
commit;
