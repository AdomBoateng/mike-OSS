import { Request, Response, NextFunction } from "express";
import { verifySession } from "../lib/session";
import { userHasVerifiedTotp } from "../lib/mfa";
import {
  csrfTokenMatches,
  isSafeMethod,
  sessionTokenFromRequest,
} from "../lib/authCookies";
import { sessionIsActive } from "../lib/userSessions";

async function applySession(req: Request, res: Response): Promise<boolean> {
  const { token, source } = sessionTokenFromRequest(req);
  if (!token || !source) {
    res.status(401).json({ detail: "Missing or invalid authentication session" });
    return false;
  }
  const claims = verifySession(token);
  if (!claims) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return false;
  }

  if (claims.sessionId) {
    try {
      if (!(await sessionIsActive(claims.sessionId, claims.sub))) {
        res.status(401).json({ detail: "Invalid or expired session" });
        return false;
      }
    } catch (err) {
      console.error("[auth] session registry check failed", err);
      res.status(503).json({ detail: "Authentication service unavailable" });
      return false;
    }
  } else if (source === "cookie") {
    // Only explicit legacy Bearer tokens may omit the server-side session id;
    // a cookie without one was not issued by the current authentication flow.
    res.status(401).json({ detail: "Invalid or expired session" });
    return false;
  }

  // Cookies are ambient browser credentials, so unsafe requests must prove
  // they came from our frontend. Explicit Bearer clients are not vulnerable to
  // browser CSRF and retain compatibility during the cookie rollout.
  if (source === "cookie" && !isSafeMethod(req.method) && !csrfTokenMatches(req)) {
    res.status(403).json({
      detail: "Missing or invalid CSRF token",
      code: "csrf_validation_failed",
    });
    return false;
  }

  res.locals.userId = claims.sub;
  res.locals.userEmail = claims.email?.toLowerCase() ?? "";
  res.locals.ldapUid = claims.ldapUid ?? "";
  res.locals.token = token;
  res.locals.authSource = source;
  res.locals.sessionId = claims.sessionId;
  res.locals.mfaVerified = claims.mfaVerified === true;
  res.locals.mfaLoginRequired = claims.mfaLoginRequired;
  return true;
}

/** Validate a session for the MFA status/challenge endpoints only. */
export function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void applySession(req, res).then((valid) => {
    if (valid) next();
  });
}

/**
 * Verify our own session token (issued by POST /auth/login after an LDAP bind)
 * and populate res.locals with the user identity.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void applySession(req, res).then((valid) => {
    if (!valid) return;

    // The React redirect is only UX. Enforce login-time MFA at the API boundary
    // so a direct client cannot use the LDAP token before completing TOTP.
    // Missing is an old-token state, so unverified legacy tokens fail closed.
    if (
      res.locals.mfaVerified !== true &&
      res.locals.mfaLoginRequired !== false
    ) {
      res.status(403).json({
        detail: "Verification required. Enter a code from your authenticator app.",
        code: "mfa_verification_required",
      });
      return;
    }
    next();
  });
}

/**
 * Step-up MFA guard for sensitive actions. If the user has a verified TOTP
 * factor but this session has not cleared a TOTP challenge, block with a 403
 * carrying `code: "mfa_verification_required"` so the frontend can prompt for a
 * code and retry with the re-issued (mfaVerified) token. Users without a factor
 * pass straight through.
 */
export async function requireMfaIfEnrolled(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = res.locals.userId;
  if (typeof userId !== "string") {
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }
  if (res.locals.mfaVerified === true) {
    next();
    return;
  }
  let enrolled: boolean;
  try {
    enrolled = await userHasVerifiedTotp(userId);
  } catch (err) {
    console.error("[auth] MFA enrollment check failed", err);
    res.status(500).json({ detail: "Unable to verify MFA status" });
    return;
  }
  if (!enrolled) {
    next();
    return;
  }
  res.status(403).json({
    detail: "Verification required. Enter a code from your authenticator app.",
    code: "mfa_verification_required",
  });
}
