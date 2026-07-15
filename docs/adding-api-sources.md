# Adding a new API tool source

Mike exposes external APIs to the assistant as **tool sources**. CourtListener is
the first one. This is the recipe for adding another (the mechanism delivered in
Phase 2 of the self-hosting roadmap — see `self-hosting-roadmap.md`).

A tool source bundles: OpenAI-style tool schemas, a system-prompt fragment, an
optional API-key provider, and a gating rule. The registry
(`backend/src/lib/toolSources/`) assembles all enabled sources' tools + prompts
and routes tool calls to the owning source.

## 1. Write the API client + tool schemas

- Put the raw HTTP/client logic in its own module, e.g.
  `backend/src/lib/<name>.ts` (mirror `courtlistener.ts`).
- Put the tool schemas + tool-name constants + system-prompt fragment in a
  module like `backend/src/lib/legalSourcesTools/<name>Tools.ts` (mirror
  `courtlistenerTools.ts`). Export `<NAME>_TOOLS`, `<NAME>_TOOL_NAMES`, and
  `<NAME>_SYSTEM_PROMPT`.

## 2. Define the ToolSource

Create `backend/src/lib/toolSources/<name>Source.ts`:

```ts
import type { OpenAIToolSchema } from "../llm/types";
import { MYAPI_TOOLS, MYAPI_SYSTEM_PROMPT } from "../legalSourcesTools/myapiTools";
import type { ToolSource } from "./types";

export const MYAPI_SOURCE_ID = "myapi";

export const myapiSource: ToolSource = {
  id: MYAPI_SOURCE_ID,
  provider: "myapi",                 // omit if the API needs no key
  tools: MYAPI_TOOLS as OpenAIToolSchema[],
  systemPrompt: MYAPI_SYSTEM_PROMPT,
  // Gate however you like. Examples:
  //   always on:            (omit isEnabled)
  //   behind a feature flag: (ctx) => ctx.flags.myFeature === true
  //   only when a key set:   (ctx) => ctx.availableProviders.has("myapi")
  isEnabled: (ctx) => ctx.availableProviders.has("myapi"),
};
```

## 3. Register it

In `backend/src/lib/toolSources/index.ts`:

```ts
import { myapiSource } from "./myapiSource";
defaultToolSources.register(myapiSource);
```

Registration throws on a duplicate id or a tool-name collision, so conflicts
surface at startup.

## 4. Add the API-key provider (only if the API needs a key)

Keys are user-configurable (encrypted at rest) with an env fallback. To add a
provider named `myapi`:

- `backend/src/lib/userApiKeys.ts`: add `"myapi"` to the `ApiKeyProvider` union
  and the `PROVIDERS` array; add a case to `envApiKey()` returning
  `process.env.MYAPI_API_KEY`.
- `backend/src/lib/userApiKeys.ts`: add `myapi: false` (and `myapi: null` under
  `sources`) to the defaults in `getUserApiKeyStatus`, and
  `myapi: envApiKey("myapi")` in `getUserApiKeys`.
- `backend/src/lib/llm/types.ts`: add `myapi?: string | null;` to `UserApiKeys`.
- **DB migration**: add `backend/migrations/<date>_add_myapi_user_api_key_provider.sql`
  that extends the `user_api_keys_provider_check` CHECK constraint to include
  `'myapi'` (copy `20260528_01_add_courtlistener_user_api_key_provider.sql`).
- `backend/.env.example`: document `MYAPI_API_KEY`.
- Frontend: add the provider to the API-keys UI
  (`frontend/src/app/(pages)/account/api-keys/page.tsx`).

Once the provider exists, `availableProvidersFrom(apiKeys)` automatically
includes it, so `ctx.availableProviders.has("myapi")` gating just works.

## 5. Dispatch the tool calls

> Interim state: tool **execution** still lives inline in
> `backend/src/lib/chatTools.ts` (a large `if/else if` on `tc.function.name`).
> Until that dispatch is migrated into `ToolSource` (a later roadmap step), add
> handler branches there keyed on your `<NAME>_TOOL_NAMES`, following the
> CourtListener branches as a template. The registry already handles discovery
> (which tools the model sees), prompting, and routing lookup
> (`defaultToolSources.sourceForTool`).

## 6. Tests

- Source: assert `defaultToolSources.tools(ctx)` / `.systemPrompt(ctx)` /
  `.sourceForTool(name, ctx)` behave as expected under your gating (see
  `toolSources/courtlistenerSource.test.ts`).
- API client: unit-test parsing/formatting; add a gated integration smoke-test
  (`*.integration.ts`, run via `npm run test:integration`) if it hits the network.

Run `npm test` (unit) and `npx tsc --noEmit` (typecheck) before committing.
