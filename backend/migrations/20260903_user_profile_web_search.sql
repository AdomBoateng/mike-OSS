-- Migration date: 2026-09-03

-- Per-user toggle for open-web search (self-hosted SearXNG).
--
-- Mirrors legal_research_us / legal_research_gh, but the default is chosen for
-- a different reason. Those two read public legal repositories and default on.
-- This one sends the user's own words to a search instance and out to upstream
-- engines, so a firm may well want it off for some accounts even where the
-- instance exists. It still defaults true to match the registry's
-- flags-default-on behaviour — the real gate is SEARXNG_BASE_URL, without
-- which the tool is never offered at all.
--
-- Safe to run before the application code: adds a column with a default, so
-- existing rows match what the backend assumes when the column is absent.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS web_search boolean NOT NULL DEFAULT true;
