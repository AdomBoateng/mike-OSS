-- Migration date: 2026-07-07
-- Adds support for a custom, user-supplied OpenAI-compatible LLM endpoint
-- (Ollama, LM Studio, vLLM, …): a `custom` API-key provider and a per-user
-- base URL stored on the profile. Safe to re-run.

-- 1. Allow the `custom` provider for stored API keys.
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'openrouter', 'custom', 'courtlistener'));

-- 2. Per-user base URL for the custom endpoint (non-secret, so plain text).
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS custom_llm_base_url text;
