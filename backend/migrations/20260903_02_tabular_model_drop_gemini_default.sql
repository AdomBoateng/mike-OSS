-- Stop handing every new account a Gemini model it cannot run.
--
-- user_profiles.tabular_model carried `default 'gemini-3-flash-preview'` from
-- upstream, where cloud providers were on offer. This fork serves models from a
-- self-hosted OpenAI-compatible endpoint only, so a fresh database was seeding
-- every account with an id no deployment here can call. Nothing broke —
-- usableStoredModel() in lib/userSettings.ts already suppresses a stored cloud
-- id when no key for it exists, and the account falls back to the utility model
-- — but the column was recording a preference the user never expressed, and it
-- showed up as "gemini-3-flash-preview" in a UAT database that had never been
-- near Google.
--
-- Null now means "no preference", which resolves to whatever the custom
-- endpoint is serving.

alter table public.user_profiles
  alter column tabular_model drop default;

alter table public.user_profiles
  alter column tabular_model drop not null;

-- Only the untouched default is cleared. A row holding some other value is a
-- choice somebody made, even a stale one, and is left alone.
update public.user_profiles
   set tabular_model = null
 where tabular_model = 'gemini-3-flash-preview';
