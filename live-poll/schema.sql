-- ─────────────────────────────────────────────────────────────
-- 실시간 의견 모으기 — Supabase 데이터베이스 설정
-- Supabase → SQL Editor → New query 에 이 파일 전체를 붙여 넣고 Run 을 누르세요.
-- (여러 번 실행해도 안전합니다.)
--
-- 구조:  교사(auth.users) ─ 활동(activities) ─ 응답(responses) ─ 투표(votes)
-- · 교사는 로그인해서 자기 활동과 응답만 직접 읽고 고칠 수 있습니다. (RLS)
-- · 학생은 로그인하지 않고, 아래 함수(join/submit/get_results/vote)로만 접근합니다.
--   그래서 학생은 다른 학생의 학번·이름을 볼 수 없고, 선생님이 공개한 정보만 받습니다.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  pin text not null unique check (pin ~ '^[0-9]{6}$'),
  class_name text not null default '' check (char_length(class_name) <= 40),
  title text not null default '' check (char_length(title) <= 100),
  question text not null check (char_length(question) between 1 and 500),
  response_type text not null check (response_type in ('choice', 'multi', 'ox', 'rating', 'word', 'short', 'card', 'rank')),
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 10),
  result_view text not null default 'bar' check (result_view in ('bar', 'pie', 'ranking', 'wordcloud', 'cards', 'list')),
  collect_student_no boolean not null default true,
  collect_name boolean not null default true,
  identity_mode text not null default 'teacher' check (identity_mode in ('public', 'teacher', 'anonymous')),
  results_visible boolean not null default false,
  allow_voting boolean not null default false,
  allow_multiple boolean not null default false,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);
create index if not exists activities_teacher_idx on public.activities (teacher_id, created_at desc);

create table if not exists public.responses (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  client_key text not null,
  student_no text,
  student_name text,
  answer jsonb not null,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists responses_activity_idx on public.responses (activity_id, client_key);

create table if not exists public.votes (
  response_id uuid not null references public.responses (id) on delete cascade,
  client_key text not null,
  primary key (response_id, client_key)
);

alter table public.activities enable row level security;
alter table public.responses enable row level security;
alter table public.votes enable row level security;

-- 교사: 자기 활동만
drop policy if exists "teacher manages own activities" on public.activities;
create policy "teacher manages own activities" on public.activities
  for all to authenticated
  using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());

-- 교사: 자기 활동의 응답만 읽기 / 숨기기
drop policy if exists "teacher reads own responses" on public.responses;
create policy "teacher reads own responses" on public.responses
  for select to authenticated
  using (exists (select 1 from public.activities a where a.id = activity_id and a.teacher_id = auth.uid()));
drop policy if exists "teacher hides own responses" on public.responses;
create policy "teacher hides own responses" on public.responses
  for update to authenticated
  using (exists (select 1 from public.activities a where a.id = activity_id and a.teacher_id = auth.uid()))
  with check (exists (select 1 from public.activities a where a.id = activity_id and a.teacher_id = auth.uid()));
-- 교사는 응답의 '숨김' 여부만 바꿀 수 있게 (학생 답 내용은 수정 불가)
revoke update on public.responses from authenticated;
grant update (hidden) on public.responses to authenticated;
-- votes 테이블은 정책이 없으므로 아래 함수로만 접근할 수 있습니다.

-- 학생에게 보여 줄 활동 정보 (교사 id 등은 빼고)
create or replace function public.livepoll_public(a public.activities)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'pin', a.pin, 'class_name', a.class_name, 'title', a.title, 'question', a.question,
    'response_type', a.response_type, 'options', a.options, 'result_view', a.result_view,
    'collect_student_no', a.collect_student_no, 'collect_name', a.collect_name, 'identity_mode', a.identity_mode,
    'results_visible', a.results_visible, 'allow_voting', a.allow_voting, 'allow_multiple', a.allow_multiple,
    'status', a.status)
$$;

create or replace function public.livepoll_is_index(v jsonb, n int)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(jsonb_typeof(v) = 'number'
    and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
    and (v #>> '{}')::numeric >= 0 and (v #>> '{}')::numeric < n, false)
$$;

-- PIN으로 활동 찾기
create or replace function public.join_activity(p_pin text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.livepoll_public(a) from public.activities a where a.pin = p_pin
$$;

-- 학생 응답 제출 (응답 1개만 허용이면, 같은 기기에서 다시 내면 답이 수정됨)
create or replace function public.submit_response(p_pin text, p_client_key text, p_student_no text, p_student_name text, p_answer jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a public.activities;
  n int;
  t text;
  lim int;
  rid uuid;
  mine int;
begin
  select * into a from public.activities where pin = p_pin;
  if not found then raise exception 'NOT_FOUND'; end if;
  if a.status <> 'open' then raise exception 'CLOSED'; end if;
  if p_client_key is null or char_length(p_client_key) not between 8 and 100 then raise exception 'BAD_ANSWER'; end if;

  -- 학생 정보: 활동 설정에 따라 받거나 버림
  p_student_no := nullif(left(trim(coalesce(p_student_no, '')), 20), '');
  p_student_name := nullif(left(trim(coalesce(p_student_name, '')), 30), '');
  if a.identity_mode = 'anonymous' or not a.collect_student_no then p_student_no := null;
  elsif p_student_no is null then raise exception 'NEED_ID'; end if;
  if a.identity_mode = 'anonymous' or not a.collect_name then p_student_name := null;
  elsif p_student_name is null then raise exception 'NEED_NAME'; end if;

  -- 답 검사 (common.js 의 cleanAnswer 와 같은 규칙)
  if p_answer is null or jsonb_typeof(p_answer) <> 'object' or octet_length(p_answer::text) > 3000 then raise exception 'BAD_ANSWER'; end if;
  n := case a.response_type when 'ox' then 2 when 'rating' then 5 else jsonb_array_length(a.options) end;
  case a.response_type
    when 'choice', 'ox' then
      if not public.livepoll_is_index(p_answer -> 'choice', n) then raise exception 'EMPTY'; end if;
      p_answer := jsonb_build_object('choice', p_answer -> 'choice');
    when 'rating' then
      if not public.livepoll_is_index(p_answer -> 'value', 6) or (p_answer ->> 'value')::numeric < 1 then raise exception 'EMPTY'; end if;
      p_answer := jsonb_build_object('value', p_answer -> 'value');
    when 'multi', 'rank' then
      t := case a.response_type when 'multi' then 'choices' else 'order' end;
      if jsonb_typeof(p_answer -> t) <> 'array' or jsonb_array_length(p_answer -> t) = 0 then raise exception 'EMPTY'; end if;
      if exists (select 1 from jsonb_array_elements(p_answer -> t) e where not public.livepoll_is_index(e, n))
        or (select count(distinct e) from jsonb_array_elements(p_answer -> t) e) <> jsonb_array_length(p_answer -> t)
        or (a.response_type = 'rank' and jsonb_array_length(p_answer -> t) <> n)
      then raise exception 'BAD_ANSWER'; end if;
      p_answer := jsonb_build_object(t, p_answer -> t);
    else -- word / short / card
      lim := case a.response_type when 'word' then 30 when 'short' then 150 else 400 end;
      t := left(trim(regexp_replace(coalesce(p_answer ->> 'text', ''), '\s+', ' ', 'g')), lim);
      if t = '' then raise exception 'EMPTY'; end if;
      p_answer := jsonb_build_object('text', t);
  end case;

  -- 같은 기기에서 동시에 두 번 눌러도 하나만 저장되도록 잠금
  perform pg_advisory_xact_lock(hashtext(a.id::text || p_client_key));
  if not a.allow_multiple then
    update public.responses set answer = p_answer, student_no = p_student_no, student_name = p_student_name
      where activity_id = a.id and client_key = p_client_key
      returning id into rid;
    if rid is not null then return rid; end if;
  else
    select count(*) into mine from public.responses where activity_id = a.id and client_key = p_client_key;
    if mine >= 20 then raise exception 'TOO_MANY'; end if;
  end if;
  insert into public.responses (activity_id, client_key, student_no, student_name, answer)
    values (a.id, p_client_key, p_student_no, p_student_name, p_answer)
    returning id into rid;
  return rid;
end;
$$;

-- 결과 가져오기
--  · 활동을 만든 선생님: 모든 응답 + 학번·이름 + 숨긴 응답
--  · 학생/그 외: 선생님이 결과를 공개했을 때만, 숨긴 응답 제외, 이름은 '친구들에게 공개'일 때만
create or replace function public.get_results(p_pin text, p_client_key text default null, p_as_student boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a public.activities;
  owner boolean;
  rows jsonb;
begin
  select * into a from public.activities where pin = p_pin;
  if not found then return null; end if;
  owner := not coalesce(p_as_student, false) and auth.uid() is not null and auth.uid() = a.teacher_id;
  if not owner and not a.results_visible then
    return jsonb_build_object('activity', public.livepoll_public(a) || jsonb_build_object('is_owner', false), 'responses', null);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'answer', r.answer, 'created_at', r.created_at,
      'hidden', case when owner then r.hidden else false end,
      'author', case
        when owner then nullif(concat_ws(' ', r.student_no, r.student_name), '')
        when a.identity_mode = 'public' then r.student_name
        else null end,
      'votes', (select count(*) from public.votes v where v.response_id = r.id),
      'voted', exists (select 1 from public.votes v where v.response_id = r.id and v.client_key = p_client_key)
    ) order by r.created_at), '[]'::jsonb)
    into rows
    from public.responses r
    where r.activity_id = a.id and (owner or not r.hidden);
  return jsonb_build_object('activity', public.livepoll_public(a) || jsonb_build_object('is_owner', owner), 'responses', rows);
end;
$$;

-- 의견에 투표 (한 번 더 누르면 취소)
create or replace function public.vote_response(p_pin text, p_response_id uuid, p_client_key text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a public.activities;
begin
  select * into a from public.activities where pin = p_pin;
  if not found then raise exception 'NOT_FOUND'; end if;
  if not a.allow_voting or not a.results_visible then raise exception 'NO_VOTING'; end if;
  if a.status <> 'open' then raise exception 'CLOSED'; end if;
  if p_client_key is null or char_length(p_client_key) not between 8 and 100 then raise exception 'BAD_ANSWER'; end if;
  if not exists (select 1 from public.responses where id = p_response_id and activity_id = a.id and not hidden) then
    raise exception 'NOT_FOUND';
  end if;
  delete from public.votes where response_id = p_response_id and client_key = p_client_key;
  if found then return false; end if;
  insert into public.votes (response_id, client_key) values (p_response_id, p_client_key) on conflict do nothing;
  return true;
end;
$$;

revoke all on function public.join_activity(text) from public;
revoke all on function public.submit_response(text, text, text, text, jsonb) from public;
revoke all on function public.get_results(text, text, boolean) from public;
revoke all on function public.vote_response(text, uuid, text) from public;
grant execute on function public.join_activity(text) to anon, authenticated;
grant execute on function public.submit_response(text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.get_results(text, text, boolean) to anon, authenticated;
grant execute on function public.vote_response(text, uuid, text) to anon, authenticated;
