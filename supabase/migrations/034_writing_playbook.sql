-- Playbook — the user's own writing, and what the AI learned from it.
--
-- Personal, not project-scoped: how someone writes follows them across every
-- matter they work on, so this hangs off the account. Both tables gate on
-- `user_id = auth.uid()` and nothing else — there is no sharing story here, and
-- a firm's drafting habits are not something to leak sideways between accounts.

-- One imported document. `excerpt` is a CAPPED slice of the text, not the file:
-- enough to re-derive the style from, deliberately not a copy of the document.
-- The file itself stays on the user's machine.
create table if not exists public.writing_samples (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  doc_kind    text,
  mime_type   text,
  char_count  integer not null default 0,
  excerpt     text not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists writing_samples_user_created_idx
  on public.writing_samples (user_id, created_at desc);

alter table public.writing_samples enable row level security;

drop policy if exists writing_samples_own on public.writing_samples;
create policy writing_samples_own on public.writing_samples
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- What the model distilled from those samples: a description of how this person
-- writes, in prose, which rides along with every drafting request. One row per
-- user — a second profile would just be a second answer to the same question.
create table if not exists public.writing_profiles (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  profile       text not null default '',
  sample_count  integer not null default 0,
  model         text,
  -- Off by default is wrong: someone who imported their documents asked for
  -- this. The switch exists so a one-off piece can be written in a neutral
  -- voice without deleting everything they taught it.
  enabled       boolean not null default true,
  generated_at  timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.writing_profiles enable row level security;

drop policy if exists writing_profiles_own on public.writing_profiles;
create policy writing_profiles_own on public.writing_profiles
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
