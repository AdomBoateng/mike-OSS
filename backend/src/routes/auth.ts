import { Router } from "express";
import { ldapAuthenticate, ldapEnabled } from "../lib/ldap";
import { upsertLdapUser, syncLdapProfile } from "../lib/authUsers";
import { signSession } from "../lib/session";
import { userHasVerifiedTotp } from "../lib/mfa";

export const authRouter = Router();

// POST /auth/login  { username, password } -> { token, user }
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

  const user = await upsertLdapUser(ldapUser.ldapUid, ldapUser.email);
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
  let hasFactor = false;
  try {
    hasFactor = await userHasVerifiedTotp(user.id);
  } catch (err) {
    console.error("[auth/login] MFA status check failed", err);
  }
  const token = signSession({
    sub: user.id,
    email: user.email ?? "",
    ldapUid: ldapUser.ldapUid,
    mfaVerified: !hasFactor,
  });

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: ldapUser.displayName,
    },
  });
});
