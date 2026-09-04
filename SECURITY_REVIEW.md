# Application Security Review

**Review date:** 2026-09-04

**Scope:** Next.js frontend, Express/TypeScript API, authentication and MFA, PostgreSQL access, uploads and document processing, outbound HTTP/MCP/LLM integrations, dependency manifests, Docker and Kubernetes deployment configuration.

**Method:** Threat-led manual review, targeted regression tests, dependency-advisory research, production builds, and checks against OWASP ASVS 5.0, OWASP Top 10 (Web/API/LLM), and NIST SSDF 1.1.

## Executive summary

The review found and fixed several material issues. The most serious were a server-side MFA enforcement gap, server-side request forgery paths in user-controlled LLM/MCP endpoints, known-vulnerable Next.js and Multer versions, permissive proxy trust that could undermine IP rate limits, and insufficient validation of uploaded file contents and AI tool execution metadata.

All implemented changes compile, the complete backend test suite passes, and the frontend production build succeeds. No obvious committed credentials were found by the targeted secret-pattern review. Browser authentication now uses hardened cookies, CSRF protection, and a shared PostgreSQL session registry instead of persistent browser bearer-token storage.

## Findings fixed

| ID | Severity | Finding | Resolution |
|---|---:|---|---|
| AUTH-01 | High | Login-time MFA was primarily enforced by frontend navigation, allowing an unverified bearer token to reach protected API routes. | Added a signed `mfaLoginRequired` session claim, server-side enforcement, fail-closed legacy-token handling, database-backed login policy checks, and protected MFA completion routes. |
| AUTH-02 | High | A 12-hour bearer JWT persisted in browser `localStorage`, so XSS could extract and reuse it off-device; logout could not revoke copied tokens across replicas. | Moved browser auth to host-only Secure/HttpOnly/SameSite cookies, added double-submit CSRF and origin checks, introduced a shared PostgreSQL session registry, and made logout revoke the session cluster-wide. |
| NET-01 | High | User-controlled custom LLM and MCP URLs could reach private, loopback, link-local, or cloud-metadata services; ordinary URL validation alone would not stop DNS rebinding. | Added public-HTTPS URL policy, DNS preflight checks, connect-time address validation, manual redirect validation, response-size limits, and credential/fragment rejection. Admin-controlled internal model endpoints remain explicitly trusted. |
| DEP-01 | High | Next.js 16.2.10 was in ranges affected by published server-side request forgery and unbounded Server Action request issues. | Upgraded and locked Next.js to 16.3.4. |
| DEP-02 | High | Multer 2.2.0 was affected by published denial-of-service issues involving malformed multipart input and unbounded bracket notation. | Upgraded to 2.3.0 and added strict multipart field, part, field-size, and array-index limits. |
| RATE-01 | High | Trusting one proxy hop by default on a directly published service allowed client-IP spoofing and rate-limit evasion. Equivalent `/users` routes also missed sensitive-operation limiters. | Default proxy trust is now zero, Kubernetes explicitly opts into one trusted hop, and equivalent route aliases share upload/export/delete controls. MFA endpoints also have dedicated limits. |
| FILE-01 | High | Upload checks trusted extensions/MIME labels and did not adequately limit hostile DOCX archive expansion. | Added signature/container validation for PDF, RTF, legacy Office, and DOCX; required DOCX entries; bounded ZIP entry count and expanded size; applied validation to upload and version routes. |
| AI-01 | High | MCP tools without reliable safety metadata could be treated as callable, creating excessive-agency risk. | Tool execution is now fail-closed: only tools explicitly marked read-only and non-destructive are automatically callable; destructive or ambiguous tools are disabled pending a future confirmation flow. |
| INPUT-01 | Medium | Chat, tabular-review, workflow, sharing, and project endpoints accepted oversized or structurally unsafe payloads. Chat history could also include client-supplied `system` roles. | Added centralized structural validation, role allowlisting, count/length limits, normalized/deduplicated sharing data, and bounded tabular schemas/prompts. |
| GHANA-01 | Medium | Ghana-law document links could escape the configured repository origin and responses were buffered without a strict delivered-byte cap. | Locked API-supplied links to the configured origin, validated document IDs, streamed with an enforced 25 MB cap, and verified PDF signatures. |
| INFO-01 | Medium | Health/readiness and SMTP checks returned raw infrastructure errors; authenticated responses could be cached by intermediaries. | Operational details are now logged server-side, health responses are generic, and authenticated/API responses receive `no-store` caching controls. |
| DEPLOY-01 | Medium | Runtime containers ran as root and frontend defense-in-depth headers were incomplete. | Both runtime images now use the unprivileged `node` user. Added CSP, HSTS, framing, MIME-sniffing, referrer, permissions, and powered-by header controls. |
| AVAIL-01 | Medium | The process continued after an uncaught exception despite potentially corrupted state. | Uncaught exceptions now terminate non-zero so the process/container supervisor can replace the instance. |
| SUPPLY-01 | Medium | Automated dependency-update coverage was absent. | Added weekly Dependabot configuration for both npm workspaces. |

## Defense-in-depth changes

- Reduced the default JSON body limit from 50 MB to a configurable 5 MB.
- Disabled credentialed cross-origin requests because the API uses explicit bearer tokens.
- Added strict response caps and redirect policy to outbound integrations.
- Applied `no-cache, no-store` semantics to streaming responses.
- Confirmed value binding and identifier quoting in the reviewed SQL-builder paths.
- Confirmed Markdown rendering does not enable raw HTML and reviewed existing DOM sanitization on rich document rendering paths.

## Verification evidence

| Check | Result |
|---|---|
| Backend full test suite | **326 passed, 0 failed** |
| Backend TypeScript build | **Passed** |
| Frontend Next.js production build | **Passed** on Next.js 16.3.4 |
| Patch whitespace check | **Passed** (`git diff --check`) |
| Frontend ESLint | **41 errors, 75 warnings** — exactly the pre-review baseline; no regression |
| Targeted tracked-secret pattern scan | No obvious committed secrets found; local environment files are ignored |

The npm advisory endpoint timed out repeatedly during this environment's review, so a complete registry-produced transitive audit report was not available. Direct dependencies with material published advisories were assessed against primary advisories and upgraded. Dependabot was added so registry-backed checks continue after this review.

## Residual risk and recommended backlog

### Priority 1

1. **Use a shared rate-limit store.** The in-memory limiter is per process. Use Redis or an ingress-native distributed limiter before scaling beyond the current replicas, and combine IP throttling with normalized account/device signals on login.
2. **Isolate document parsing.** Move LibreOffice and complex document parsing into a sandboxed worker with concurrency quotas, CPU/time limits, malware scanning, and content disarm/reconstruction where appropriate. Avoid retaining 100 MB uploads entirely in API-process memory.
3. **Normalize asynchronous Express error handling.** Express 4 does not automatically route rejected async handlers to error middleware. Wrap all async routes or migrate to a framework/runtime version with consistent promise-error handling, then terminate on truly unhandled rejections.

### Priority 2

1. Add organization-level MFA enforcement, one-time recovery codes, replay prevention for accepted TOTP time steps, and preferably WebAuthn/passkeys.
2. Replace per-route error bodies with a centralized, redacted production error policy and structured security logging.
3. Add security audit events for login/MFA changes, API-key changes, connector authorization, exports, deletes, sharing, and administrative configuration changes.
4. Replace CSP `unsafe-inline` allowances with nonce- or hash-based script/style policy as the Next.js rendering architecture permits.
5. Add Kubernetes egress policy around the API and document worker. Explicitly allow only DNS, LDAP, object storage, configured model services, and approved public connector destinations.
6. Run dependency audit, secret scanning, SAST, container scanning, and SBOM generation in CI; fail releases on exploitable high/critical findings with documented exceptions.
7. Resolve the existing frontend lint baseline, especially hook-state and unsafe `any` findings, so future security-relevant regressions are easier to distinguish.

## Reference baseline

- [OWASP Application Security Verification Standard 5.0](https://owasp.org/www-project-application-security-verification-standard/)
- [OWASP Top 10: 2025](https://owasp.org/Top10/2025/)
- [OWASP API Security Top 10: 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [OWASP Top 10 for Large Language Model Applications](https://genai.owasp.org/llm-top-10/)
- [NIST Secure Software Development Framework 1.1](https://csrc.nist.gov/pubs/sp/800/218/final)
- [Next.js SSRF advisory GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4)
- [Next.js unbounded Server Action request advisory GHSA-4c39-4ccg-62r3](https://github.com/advisories/GHSA-4c39-4ccg-62r3)
- [Multer August 2026 security releases](https://expressjs.com/en/blog/2026-08-31-security-releases/)

## Review limitations

This was a source/configuration review with automated unit/build verification. It did not include a deployed-environment penetration test, authenticated dynamic scanner, cloud/IAM review, live LDAP/PostgreSQL/S3 integration test, production network-policy validation, or manual abuse testing against real third-party MCP/LLM services. Those are necessary before treating the system as independently penetration-tested.
