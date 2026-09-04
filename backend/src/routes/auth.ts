import { Router } from "express";
import { ldapAuthenticate, ldapEnabled } from "../lib/ldap";
import { upsertLdapUser, syncLdapProfile } from "../lib/authUsers";
import { userHasVerifiedTotp } from "../lib/mfa";
import { createServerSupabase } from "../lib/supabase";
import { safeErrorLog } from "../lib/safeError";
import { requireSession } from "../middleware/auth";
import {
  clearAuthCookies,
  exposeLegacyBearerTokens,
  setAuthCookies,
} from "../lib/authCookies";
import { issueSession, revokeSession } from "../lib/userSessions";

export const authRouter = Router();

// POST /auth/login  { username, password } -> { user }
// Authenticates against the LDAP directory, upserts the app user (seeding a
// profile on first login), and issues our own session token.
authRouter.post("/login", async (req, res) => {
  if (!ldapEnabled()) {
    res.status(503).json({ detail: "LDAP auth is not configured" });
    return;
  }

  const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    res.status(400).json({ detail: "username and password are required" });
    return;
  }

  let ldapUser;
  try {
    ldapUser = await ldapAuthenticate(username, password);
  } catch (err) {
    console.error("[auth/login] LDAP error", err);
    res.status(502).json({ detail: "Authentication service unavailable" });
    return;
  }

  if (!ldapUser) {
    res.status(401).json({ detail: "Invalid username or password" });
    return;
  }

  let user: Awaited<ReturnType<typeof upsertLdapUser>>;
  try {
    user = await upsertLdapUser(ldapUser.ldapUid, ldapUser.email);
  } catch (err) {
    console.error("[auth/login] failed to persist LDAP user", safeErrorLog(err));
    res.status(503).json({ detail: "Authentication service unavailable" });
    return;
  }
  // LDAP is the source of truth for display name + organisation (read-only in
  // the app), so refresh the profile from the directory on every login. A
  // failure here shouldn't block sign-in.
  try {
    await syncLdapProfile(
      user.id,
      ldapUser.displayName,
      ldapUser.organisation,
    );
  } catch (err) {
    console.error("[auth/login] failed to sync LDAP profile", err);
  }
  // A fresh login has not cleared a TOTP challenge. If the user has a verified
  // factor, mfaVerified stays false until they step up (login gate for
  // mfa_on_login users, and on demand for sensitive actions). Users with no
  // factor are trivially "verified" so nothing gates them.
  let hasFactor: boolean;
  let mfaOnLogin: boolean;
  try {
    const db = createServerSupabase();
    const [factor, profileResult] = await Promise.all([
      userHasVerifiedTotp(user.id, db),
      db
        .from("user_profiles")
        .select("mfa_on_login")
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);
    if (profileResult.error) throw profileResult.error;
    hasFactor = factor;
    mfaOnLogin =
      (profileResult.data as { mfa_on_login?: boolean } | null)
        ?.mfa_on_login === true;
  } catch (err) {
    // Fail closed. Otherwise a transient factor-store failure creates a fully
    // verified token that remains valid after the database recovers.
    console.error("[auth/login] MFA status check failed", safeErrorLog(err));
    res.status(503).json({ detail: "Authentication service unavailable" });
    return;
  }
  let token: string;
  try {
    ({ token } = await issueSession({
      sub: user.id,
      email: user.email ?? "",
      ldapUid: ldapUser.ldapUid,
      mfaVerified: !hasFactor,
      mfaLoginRequired: hasFactor && mfaOnLogin,
    }));
  } catch (err) {
    console.error("[auth/login] failed to create session", safeErrorLog(err));
    res.status(503).json({ detail: "Authentication service unavailable" });
    return;
  }
  setAuthCookies(res, token);

  res.json({
    ...(exposeLegacyBearerTokens() ? { token } : {}),
    user: {
      id: user.id,
      email: user.email,
      displayName: ldapUser.displayName,
      mfaVerified: !hasFactor,
      mfaLoginRequired: hasFactor && mfaOnLogin,
    },
  });
});

// Rehydrate browser auth from the HttpOnly cookie. During rollout this also
// exchanges an existing Bearer token for cookies, after which the frontend
// removes the legacy token from localStorage.
authRouter.get("/session", requireSession, async (_req, res) => {
  const user = {
    id: res.locals.userId as string,
    email: (res.locals.userEmail as string) ?? "",
    mfaVerified: res.locals.mfaVerified === true,
    mfaLoginRequired: res.locals.mfaLoginRequired === true,
  };
  try {
    let token = res.locals.token as string;
    if (typeof res.locals.sessionId !== "string") {
      ({ token } = await issueSession({
        sub: user.id,
        email: user.email,
        ldapUid: (res.locals.ldapUid as string) ?? "",
        mfaVerified: user.mfaVerified,
        mfaLoginRequired: user.mfaLoginRequired,
      }));
    }
    setAuthCookies(res, token);
    res.json({ user });
  } catch (err) {
    console.error("[auth/session] migration failed", safeErrorLog(err));
    res.status(503).json({ detail: "Authentication service unavailable" });
  }
});

authRouter.post("/logout", requireSession, async (_req, res) => {
  try {
    if (typeof res.locals.sessionId === "string") {
      await revokeSession(res.locals.sessionId, res.locals.userId as string);
    }
    clearAuthCookies(res);
    res.status(204).end();
  } catch (err) {
    console.error("[auth/logout] session revocation failed", safeErrorLog(err));
    res.status(503).json({ detail: "Authentication service unavailable" });
  }
});
