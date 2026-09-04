// Our own session tokens, replacing Supabase-issued JWTs. Signed with
// SESSION_JWT_SECRET (HS256). Issued by /auth/login after a successful LDAP
// bind; verified by the auth middleware.

import jwt, { type SignOptions } from "jsonwebtoken";

export interface SessionClaims {
  /** Application user id (auth.users.id UUID). */
  sub: string;
  email: string;
  ldapUid: string;
  /**
   * Whether this session has cleared a TOTP step-up check. Absent/false means
   * sensitive actions require verification (when the user has a verified
   * factor). A successful challenge re-issues the token with this set true.
   */
  mfaVerified?: boolean;
  /** Whether ordinary API access must wait for login-time TOTP. */
  mfaLoginRequired?: boolean;
}

const DEFAULT_TTL: SignOptions["expiresIn"] = "12h";

function secret(): string {
  const s = process.env.SESSION_JWT_SECRET;
  if (!s) throw new Error("SESSION_JWT_SECRET is not set");
  return s;
}

export function signSession(
  claims: SessionClaims,
  expiresIn: SignOptions["expiresIn"] = DEFAULT_TTL,
): string {
  return jwt.sign(claims, secret(), { expiresIn, algorithm: "HS256" });
}

/** Verify a session token; returns claims or null if invalid/expired. */
export function verifySession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    if (
      typeof decoded === "object" &&
      decoded !== null &&
      typeof (decoded as SessionClaims).sub === "string"
    ) {
      const d = decoded as SessionClaims & {
        email?: string;
        ldapUid?: string;
        mfaVerified?: boolean;
        mfaLoginRequired?: boolean;
      };
      return {
        sub: d.sub,
        email: d.email ?? "",
        ldapUid: d.ldapUid ?? "",
        mfaVerified: d.mfaVerified === true,
        mfaLoginRequired:
          typeof d.mfaLoginRequired === "boolean"
            ? d.mfaLoginRequired
            : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
