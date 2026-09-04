import { Request, Response, NextFunction } from "express";
import { verifySession } from "../lib/session";
import { userHasVerifiedTotp } from "../lib/mfa";

function applySession(req: Request, res: Response): boolean {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return false;
  }
  const token = auth.slice(7).trim();
  const claims = verifySession(token);
  if (!claims) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return false;
  }

  res.locals.userId = claims.sub;
  res.locals.userEmail = claims.email?.toLowerCase() ?? "";
  res.locals.ldapUid = claims.ldapUid ?? "";
  res.locals.token = token;
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
  if (applySession(req, res)) next();
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
  if (!applySession(req, res)) return;

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
