-- Per-project jurisdiction (033).
--
-- Which country's law a project is worked under. Until now "Romanian law firm"
-- was hard-coded into every AI system prompt (project-ai, doc-ai, legal-ai);
-- this column is what lets a project say otherwise, so the AI cites the right
-- legislation, courts and default answer language.
--
-- Stored as an ISO 3166-1 alpha-2 code ('RO', 'DE', …) plus the supranational
-- 'EU' for projects that are EU-law-first. NULL means "not set" and every
-- consumer falls back to the app default (Romania), so existing projects keep
-- behaving exactly as they do today.
--
-- Deliberately not an enum: the catalog lives in the app
-- (src/lib/jurisdictions.js + supabase/functions/_shared/jurisdictions.ts) and
-- adding a country there shouldn't need a migration. The Edge Functions
-- allow-list the value before it reaches a prompt, so an unknown code degrades
-- to the default rather than injecting free text into the system prompt.

alter table public.projects
  add column if not exists jurisdiction text;

alter table public.projects
  drop constraint if exists projects_jurisdiction_format;

-- Shape check only (2-letter uppercase); the app owns which codes are real.
alter table public.projects
  add constraint projects_jurisdiction_format
  check (jurisdiction is null or jurisdiction ~ '^[A-Z]{2}$');

comment on column public.projects.jurisdiction is
  'ISO 3166-1 alpha-2 country code (or ''EU'') whose law this project is worked under. NULL = app default (RO).';

-- No RLS change needed: writes ride the existing "admins update projects"
-- policy, the same one that guards name / description / ai_context.
