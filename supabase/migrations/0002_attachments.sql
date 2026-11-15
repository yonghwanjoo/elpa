-- File attachments on chat messages, stored in a private bucket under "<team id>/<random>.<ext>".

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 20971520)
on conflict (id) do nothing;

create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select private.my_team())::text);
create policy attachments_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = (select private.my_team())::text);

alter table public.messages add column attachments jsonb not null default '[]'::jsonb;
alter table public.messages drop constraint messages_text_check;
alter table public.messages add constraint messages_text_check
  check (char_length(text) <= 4000 and (btrim(text) <> '' or jsonb_array_length(attachments) > 0));

-- A message may only reference files that exist in the sender's own team folder.
create function private.valid_attachments(a jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when jsonb_typeof(a) <> 'array' then false
    when jsonb_array_length(a) > 5 or pg_column_size(a) > 4000 then false
    else not exists (
      select 1 from jsonb_array_elements(a) e
      where jsonb_typeof(e) <> 'object'
         or coalesce(e->>'path', '') not like private.my_team()::text || '/%'
         or char_length(coalesce(e->>'name', '')) not between 1 and 200
         or jsonb_typeof(e->'size') is distinct from 'number'
         or char_length(coalesce(e->>'type', '')) > 100
         or not exists (select 1 from storage.objects o where o.bucket_id = 'attachments' and o.name = e->>'path')
    )
  end
$$;
revoke execute on function private.valid_attachments(jsonb) from public, anon;
grant execute on function private.valid_attachments(jsonb) to authenticated;

drop policy messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated
  with check (
    team_id = (select private.my_team())
    and author_id = (select auth.uid())
    and system = false
    and task_id is null
    and exists (select 1 from public.channels c where c.id = channel_id and c.team_id = (select private.my_team()))
    and private.valid_attachments(attachments)
  );
grant insert (attachments) on public.messages to authenticated;

-- get_state() now also returns the team id and each message's attachments.
create or replace function public.get_state()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select case when p.id is null then null else jsonb_build_object(
    'me', p.id,
    'team', (select jsonb_build_object('id', t.id, 'name', t.name, 'inviteCode', t.invite_code) from public.teams t where t.id = p.team_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'color', m.color) order by m.created_at)
                         from public.profiles m where m.team_id = p.team_id), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.created_at)
                          from public.channels c where c.team_id = p.team_id), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(x.j order by x.ts) from (
                            select jsonb_build_object('id', g.id, 'channelId', g.channel_id, 'authorId', g.author_id, 'text', g.text,
                                     'ts', (extract(epoch from g.ts) * 1000)::bigint, 'taskId', g.task_id, 'system', g.system, 'attachments', g.attachments) as j, g.ts
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
