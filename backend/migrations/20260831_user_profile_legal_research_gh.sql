-- Migration date: 2026-08-31

-- Per-user toggle for Ghana legal research (Parliament of Ghana legislation)
-- tools in chat.
--
-- Mirrors legal_research_us. When true (the default), the ghana_law_* tools and
-- their system prompt are exposed to the chat assistant; when false, both are
-- excluded. Surfaced in account settings under Features > Legal Research >
-- Jurisdiction > Ghana.
--
-- The two jurisdictions are deliberately separate columns rather than one
-- "legal research" flag: a Ghanaian firm may well want Ghana on and US off, and
-- a single switch cannot express that.
--
-- Safe to run before application code changes: this only adds a column with a
-- default that enables the feature for all existing rows, matching the
-- backend's default when the column is absent.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS legal_research_gh boolean NOT NULL DEFAULT true;
