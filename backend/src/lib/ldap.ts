// LDAP authentication against the external directory (FreeIPA). Replaces
// Supabase email/password auth.
//
// Flow: bind as the search account -> find the user entry by username -> bind as
// that user's DN with the supplied password (the actual credential check) ->
// return the user's stable id + profile attributes.
//
// Config (see .env.example), mirroring the values in the repo-root LDAP config:
//   LDAP_URL                 e.g. ldap://172.18.200.150:389
//   LDAP_SEARCH_BIND_DN      service account DN used to search
//   LDAP_SEARCH_BIND_PASSWORD
//   LDAP_USER_BASE_DN        base DN to search for users
//   LDAP_USERNAME_ATTRIBUTE  default "uid"
//   LDAP_MAIL_ATTRIBUTE      default "mail"
//   LDAP_ORG_ATTRIBUTE       default "o"  (organisation; e.g. "o" or "ou")

import { Client } from "ldapts";

export interface LdapConfig {
  url: string;
  searchBindDn: string;
  searchBindPassword: string;
  userBaseDn: string;
  usernameAttribute: string;
  mailAttribute: string;
  /** Attributes to source the organisation from, in priority order (e.g. o, ou). */
  orgAttributes: string[];
  timeoutMs: number;
}

export interface LdapUser {
  /** The username attribute value (e.g. uid) — stable directory identifier. */
  ldapUid: string;
  email: string | null;
  displayName: string | null;
  organisation: string | null;
  dn: string;
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function resolveLdapConfig(): LdapConfig | null {
  const url = env("LDAP_URL");
  const searchBindDn = env("LDAP_SEARCH_BIND_DN");
  const searchBindPassword = env("LDAP_SEARCH_BIND_PASSWORD");
  const userBaseDn = env("LDAP_USER_BASE_DN");
  if (!url || !searchBindDn || !searchBindPassword || !userBaseDn) return null;
  return {
    url,
    searchBindDn,
    searchBindPassword,
    userBaseDn,
    usernameAttribute: env("LDAP_USERNAME_ATTRIBUTE") ?? "uid",
    mailAttribute: env("LDAP_MAIL_ATTRIBUTE") ?? "mail",
    // Comma-separated; first populated attribute wins. Defaults to o then ou.
    orgAttributes: (env("LDAP_ORG_ATTRIBUTE") ?? "o,ou")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: Number(env("LDAP_OPERATION_TIMEOUT_MS") ?? "10000"),
  };
}

export function ldapEnabled(): boolean {
  return resolveLdapConfig() !== null;
}

/** Escape a value for safe use in an LDAP search filter (RFC 4515). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      case "\0":
        return "\\00";
      default:
        return c;
    }
  });
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

/**
 * Authenticate a username/password against the directory. Returns the user's
 * directory identity on success, or null on bad credentials / unknown user.
 * Throws only on configuration or connection errors.
 */
export async function ldapAuthenticate(
  username: string,
  password: string,
): Promise<LdapUser | null> {
  const cfg = resolveLdapConfig();
  if (!cfg) throw new Error("LDAP is not configured");
  // An empty password with some LDAP servers performs an "unauthenticated bind"
  // that succeeds — reject up front.
  if (!username || !password) return null;

  const client = new Client({ url: cfg.url, timeout: cfg.timeoutMs });
  try {
    await client.bind(cfg.searchBindDn, cfg.searchBindPassword);

    const filter = `(${cfg.usernameAttribute}=${escapeFilterValue(username)})`;
    const { searchEntries } = await client.search(cfg.userBaseDn, {
      scope: "sub",
      filter,
      attributes: [
        cfg.usernameAttribute,
        cfg.mailAttribute,
        ...cfg.orgAttributes,
        "givenName",
        "sn",
        "cn",
      ],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null; // unknown or ambiguous

    const entry = searchEntries[0];
    const dn = entry.dn;

    // The credential check: bind as the user's own DN with their password.
    try {
      await client.bind(dn, password);
    } catch {
      return null; // invalid password
    }

    return mapEntryToUser(cfg, entry, dn);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}

/** Map a raw LDAP search entry to our LdapUser shape. Returns null if the entry
 * lacks the username attribute (the stable directory id). */
function mapEntryToUser(
  cfg: LdapConfig,
  entry: Record<string, unknown> & { dn?: string },
  dn: string,
): LdapUser | null {
  const ldapUid = firstString(entry[cfg.usernameAttribute]);
  if (!ldapUid) return null;
  const given = firstString(entry.givenName);
  const sn = firstString(entry.sn);
  const displayName =
    [given, sn].filter(Boolean).join(" ").trim() || firstString(entry.cn);
  // First populated org attribute wins (e.g. o, then ou).
  const organisation =
    cfg.orgAttributes
      .map((attr) => firstString(entry[attr]))
      .find((v): v is string => !!v && v.trim().length > 0) ?? null;
  return {
    ldapUid,
    email: firstString(entry[cfg.mailAttribute]),
    displayName: displayName || null,
    organisation: organisation || null,
    dn,
  };
}

/**
 * Look up a directory entry by email address (no credential bind). Returns the
 * matching user, or null if the address is unknown or ambiguous / LDAP is not
 * configured. Used to decide whether a project invitee can sign in with their
 * LDAP credentials.
 */
export async function ldapFindByEmail(
  email: string,
): Promise<LdapUser | null> {
  const cfg = resolveLdapConfig();
  if (!cfg) return null;
  const normalized = email.trim();
  if (!normalized) return null;

  const client = new Client({ url: cfg.url, timeout: cfg.timeoutMs });
  try {
    await client.bind(cfg.searchBindDn, cfg.searchBindPassword);
    const filter = `(${cfg.mailAttribute}=${escapeFilterValue(normalized)})`;
    const { searchEntries } = await client.search(cfg.userBaseDn, {
      scope: "sub",
      filter,
      attributes: [
        cfg.usernameAttribute,
        cfg.mailAttribute,
        ...cfg.orgAttributes,
        "givenName",
        "sn",
        "cn",
      ],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null; // unknown or ambiguous
    const entry = searchEntries[0];
    return mapEntryToUser(cfg, entry, entry.dn);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}
