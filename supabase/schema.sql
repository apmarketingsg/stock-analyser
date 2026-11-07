-- One row per user. The whole portfolio (transactions, settings) is a single
-- JSON document in the `data` column, read on sign-in and rewritten on save.
create table if not exists public.portfolios (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint portfolio_size_limit check (pg_column_size(data) < 1000000)
);

-- Row-level security: each signed-in user can only see and change their own row.
alter table public.portfolios enable row level security;

create policy "Users read own portfolio" on public.portfolios
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create own portfolio" on public.portfolios
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update own portfolio" on public.portfolios
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own portfolio" on public.portfolios
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.portfolios from anon;
grant select, insert, update, delete on public.portfolios to authenticated;

-- Keep updated_at current on every save.
create or replace function public.portfolios_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists portfolios_touch_updated_at on public.portfolios;
create trigger portfolios_touch_updated_at
  before update on public.portfolios
  for each row execute function public.portfolios_touch_updated_at();

-- Secret question for password reset. Answers are stored only as salted
-- scrypt hashes. Row-level security is on with NO policies, so browsers
-- (signed in or not) cannot read or write this table at all; only the
-- server, using the secret key in api/security.js, can.
create table if not exists public.security_questions (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  email           text not null unique,
  question        text not null check (char_length(question) between 5 and 200),
  answer_hash     text not null,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.security_questions enable row level security;
revoke all on public.security_questions from anon, authenticated;

drop trigger if exists security_questions_touch_updated_at on public.security_questions;
create trigger security_questions_touch_updated_at
  before update on public.security_questions
  for each row execute function public.portfolios_touch_updated_at();
