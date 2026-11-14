-- ELPA: schema, row-level security and server-side functions.
-- Every row belongs to a team; a signed-in user can only reach rows of their own team.

create schema if not exists private;

/* ---------- tables ---------- */
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  team_id uuid not null references public.teams (id),
  name text not null check (char_length(name) between 1 and 30),
  color text not null,
  created_at timestamptz not null default now()
);
create index profiles_team on public.profiles (team_id);

-- The caller's team. SECURITY DEFINER so policies on profiles can use it without recursing.
create function private.my_team() returns uuid
language sql stable security definer set search_path = '' as $$
  select team_id from public.profiles where id = (select auth.uid())
$$;

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null default private.my_team() references public.teams (id),
  name text not null check (char_length(name) between 1 and 30),
  created_at timestamptz not null default now()
);
create index channels_team on public.channels (team_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null default private.my_team() references public.teams (id),
  channel_id uuid not null references public.channels (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id),
  text text not null check (char_length(text) between 1 and 4000),
  ts timestamptz not null default clock_timestamp(),
  task_id uuid,
  system boolean not null default false
);
create index messages_team_ts on public.messages (team_id, ts desc);
create index messages_channel on public.messages (channel_id);
create index messages_author on public.messages (author_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id),
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  assignee_id uuid not null references public.profiles (id),
  due text not null default '' check (due = '' or due ~ '^\d{4}-\d{2}-\d{2}$'),
  channel_id uuid references public.channels (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references public.profiles (id)
);
create index tasks_team on public.tasks (team_id);
create index tasks_assignee on public.tasks (assignee_id);
create index tasks_channel on public.tasks (channel_id);
create index tasks_message on public.tasks (message_id);
create index tasks_created_by on public.tasks (created_by);
create index tasks_done_by on public.tasks (done_by);

alter table public.messages
  add constraint messages_task_fk foreign key (task_id) references public.tasks (id) on delete set null;
create index messages_task on public.messages (task_id);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null default private.my_team() references public.teams (id),
  title text not null default '' check (char_length(title) <= 80),
  body text not null default '' check (char_length(body) <= 50000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null default auth.uid() references public.profiles (id)
);
create index notes_team on public.notes (team_id);
create index notes_updated_by on public.notes (updated_by);

create table public.reads (
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  ts timestamptz not null default now(),
  primary key (user_id, channel_id)
);
create index reads_channel on public.reads (channel_id);

create function private.touch_note() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger notes_touch before update on public.notes
  for each row execute function private.touch_note();

/* ---------- row-level security ---------- */
alter table public.teams enable row level security;
alter table public.profiles enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.tasks enable row level security;
alter table public.notes enable row level security;
alter table public.reads enable row level security;

create policy teams_select on public.teams for select to authenticated
  using (id = (select private.my_team()));
create policy profiles_select on public.profiles for select to authenticated
  using (team_id = (select private.my_team()));

create policy channels_select on public.channels for select to authenticated
  using (team_id = (select private.my_team()));
create policy channels_insert on public.channels for insert to authenticated
  with check (team_id = (select private.my_team()));

create policy messages_select on public.messages for select to authenticated
  using (team_id = (select private.my_team()));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    team_id = (select private.my_team())
    and author_id = (select auth.uid())
    and system = false
    and task_id is null
    and exists (select 1 from public.channels c where c.id = channel_id and c.team_id = (select private.my_team()))
  );

create policy tasks_select on public.tasks for select to authenticated
  using (team_id = (select private.my_team()));

create policy notes_select on public.notes for select to authenticated
  using (team_id = (select private.my_team()));
create policy notes_insert on public.notes for insert to authenticated
  with check (team_id = (select private.my_team()) and updated_by = (select auth.uid()));
create policy notes_update on public.notes for update to authenticated
  using (team_id = (select private.my_team())) with check (team_id = (select private.my_team()));
create policy notes_delete on public.notes for delete to authenticated
  using (team_id = (select private.my_team()));

create policy reads_select on public.reads for select to authenticated
  using (user_id = (select auth.uid()));

-- Table privileges: nothing for anonymous visitors; signed-in users get only the columns
-- they may write. Everything else (tasks, teams, profiles, reads) goes through the functions below.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.teams, public.profiles, public.channels, public.messages, public.tasks, public.notes, public.reads to authenticated;
grant insert (name) on public.channels to authenticated;
grant insert (channel_id, text) on public.messages to authenticated;
grant insert (title, body) on public.notes to authenticated;
grant update (title, body) on public.notes to authenticated;
grant delete on public.notes to authenticated;

/* ---------- functions ---------- */
-- First step after sign-up: create a team, or join one with an invite code.
create function public.join_team(p_name text, p_team_name text default '', p_invite_code text default '')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_team uuid;
  v_count int;
  v_colors text[] := array['#1f6f54', '#c2531f', '#5b5fc7', '#b0406f', '#2f7fa8', '#8a6a1f', '#6b4fa0', '#3f7a3a'];
begin
  if v_uid is null then raise exception '로그인이 필요해요.'; end if;
  if exists (select 1 from public.profiles where id = v_uid) then return; end if;
  p_name := btrim(coalesce(p_name, ''));
  if char_length(p_name) not between 1 and 30 then raise exception '이름은 1~30자로 입력해 주세요.'; end if;

  if btrim(coalesce(p_invite_code, '')) <> '' then
    select id into v_team from public.teams where invite_code = upper(btrim(p_invite_code));
    if v_team is null then raise exception '초대 코드를 찾을 수 없어요.'; end if;
  else
    p_team_name := btrim(coalesce(p_team_name, ''));
    if char_length(p_team_name) not between 1 and 40 then raise exception '팀 이름은 1~40자로 입력해 주세요.'; end if;
    insert into public.teams (name, invite_code)
      values (p_team_name, upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)))
      returning id into v_team;
    insert into public.channels (team_id, name) values (v_team, '전체');
  end if;

  select count(*) into v_count from public.profiles where team_id = v_team;
  insert into public.profiles (id, team_id, name, color) values (v_uid, v_team, p_name, v_colors[(v_count % 8) + 1]);
end $$;

-- Internal: change a task's status; completing it announces that in the task's channel.
create function private.set_task_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_task public.tasks;
  v_me text;
begin
  if p_status not in ('todo', 'doing', 'done') then raise exception '상태 값이 올바르지 않아요.'; end if;
  select * into v_task from public.tasks where id = p_id and team_id = private.my_team() for update;
  if not found then raise exception '할 일을 찾을 수 없어요.'; end if;
  if v_task.status = p_status then return; end if;
  if p_status = 'done' then
    update public.tasks set status = 'done', done_at = now(), done_by = v_uid where id = p_id;
    if v_task.channel_id is not null then
      select name into v_me from public.profiles where id = v_uid;
      insert into public.messages (team_id, channel_id, author_id, text, system)
        values (v_task.team_id, v_task.channel_id, v_uid, format('%s님이 「%s」을(를) 완료했어요.', v_me, v_task.title), true);
    end if;
  else
    update public.tasks set status = p_status, done_at = null, done_by = null where id = p_id;
  end if;
end $$;

create function public.create_task(p_title text, p_assignee uuid, p_due text default '', p_status text default 'todo', p_message_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_team uuid := private.my_team();
  v_me text;
  v_assignee text;
  v_channel uuid;
  v_id uuid;
  v_msg public.messages;
begin
  if v_team is null then raise exception '로그인이 필요해요.'; end if;
  p_title := btrim(coalesce(p_title, ''));
  if char_length(p_title) not between 1 and 120 then raise exception '제목은 1~120자로 입력해 주세요.'; end if;
  p_due := coalesce(p_due, '');
  if p_due <> '' and p_due !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '마감일 형식이 올바르지 않아요.'; end if;
  p_status := coalesce(p_status, 'todo');
  if p_status not in ('todo', 'doing', 'done') then raise exception '상태 값이 올바르지 않아요.'; end if;
  select name into v_assignee from public.profiles where id = p_assignee and team_id = v_team;
  if v_assignee is null then raise exception '담당자를 찾을 수 없어요.'; end if;

  if p_message_id is not null then
    select * into v_msg from public.messages where id = p_message_id and team_id = v_team for update;
    if not found then raise exception '메시지를 찾을 수 없어요.'; end if;
    if v_msg.task_id is not null then raise exception '이미 할 일로 만든 메시지예요.'; end if;
    v_channel := v_msg.channel_id;
  end if;

  insert into public.tasks (team_id, title, assignee_id, due, channel_id, message_id, created_by)
    values (v_team, p_title, p_assignee, p_due, v_channel, p_message_id, v_uid)
    returning id into v_id;
  if p_message_id is not null then
    update public.messages set task_id = v_id where id = p_message_id;
  end if;
  if v_channel is not null and p_assignee <> v_uid then
    select name into v_me from public.profiles where id = v_uid;
    insert into public.messages (team_id, channel_id, author_id, text, system)
      values (v_team, v_channel, v_uid, format('%s님이 %s님에게 「%s」을(를) 요청했어요.', v_me, v_assignee, p_title), true);
  end if;
  if p_status <> 'todo' then perform private.set_task_status(v_id, p_status); end if;
  return v_id;
end $$;

-- Null arguments leave that field unchanged.
create function public.update_task(p_id uuid, p_title text default null, p_assignee uuid default null, p_due text default null, p_status text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid := private.my_team();
begin
  if v_team is null then raise exception '로그인이 필요해요.'; end if;
  if not exists (select 1 from public.tasks where id = p_id and team_id = v_team) then raise exception '할 일을 찾을 수 없어요.'; end if;
  if p_title is not null then
    p_title := btrim(p_title);
    if char_length(p_title) not between 1 and 120 then raise exception '제목은 1~120자로 입력해 주세요.'; end if;
    update public.tasks set title = p_title where id = p_id;
  end if;
  if p_assignee is not null then
    if not exists (select 1 from public.profiles where id = p_assignee and team_id = v_team) then raise exception '담당자를 찾을 수 없어요.'; end if;
    update public.tasks set assignee_id = p_assignee where id = p_id;
  end if;
  if p_due is not null then
    if p_due <> '' and p_due !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '마감일 형식이 올바르지 않아요.'; end if;
    update public.tasks set due = p_due where id = p_id;
  end if;
  if p_status is not null then perform private.set_task_status(p_id, p_status); end if;
end $$;

create function public.delete_task(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.tasks where id = p_id and team_id = private.my_team();
  if not found then raise exception '할 일을 찾을 수 없어요.'; end if;
end $$;

create function public.mark_read(p_channel uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.channels where id = p_channel and team_id = private.my_team()) then
    raise exception '대화방을 찾을 수 없어요.';
  end if;
  insert into public.reads (user_id, channel_id, ts) values (auth.uid(), p_channel, now())
    on conflict (user_id, channel_id) do update set ts = excluded.ts;
end $$;

-- Everything the app shows, in one round trip. Runs with the caller's rights, so RLS applies.
-- Returns null when the user has not joined a team yet.
create function public.get_state()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'me', p.id,
    'team', (select jsonb_build_object('name', t.name, 'inviteCode', t.invite_code) from public.teams t where t.id = p.team_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'color', m.color) order by m.created_at)
                         from public.profiles m where m.team_id = p.team_id), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.created_at)
                          from public.channels c where c.team_id = p.team_id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(x.j order by x.ts) from (
                            select jsonb_build_object('id', g.id, 'channelId', g.channel_id, 'authorId', g.author_id, 'text', g.text,
                                     'ts', (extract(epoch from g.ts) * 1000)::bigint, 'taskId', g.task_id, 'system', g.system) as j, g.ts
                            from public.messages g where g.team_id = p.team_id order by g.ts desc limit 500) x), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'status', k.status, 'assigneeId', k.assignee_id,
                                 'due', k.due, 'channelId', k.channel_id, 'messageId', k.message_id, 'createdBy', k.created_by,
                                 'createdAt', (extract(epoch from k.created_at) * 1000)::bigint,
                                 'doneAt', (extract(epoch from k.done_at) * 1000)::bigint, 'doneBy', k.done_by) order by k.created_at)
                       from public.tasks k where k.team_id = p.team_id), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body,
                                 'updatedAt', (extract(epoch from n.updated_at) * 1000)::bigint))
                       from public.notes n where n.team_id = p.team_id), '[]'::jsonb),
    'lastRead', coalesce((select jsonb_object_agg(r.channel_id, (extract(epoch from r.ts) * 1000)::bigint)
                          from public.reads r where r.user_id = p.id), '{}'::jsonb)
  ) end
  from (select 1) one left join public.profiles p on p.id = (select auth.uid())
$$;

-- Functions are callable by PUBLIC by default: lock them down to signed-in users.
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.my_team() to authenticated;
grant execute on function public.join_team(text, text, text), public.create_task(text, uuid, text, text, uuid),
  public.update_task(uuid, text, uuid, text, text), public.delete_task(uuid), public.mark_read(uuid), public.get_state() to authenticated;

/* ---------- realtime ---------- */
alter publication supabase_realtime add table public.messages, public.tasks, public.notes, public.channels, public.profiles;
