import dns from "dns/promises";
import net from "net";
import { Agent } from "undici";

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
]);

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Words(ip: string): number[] | null {
  let normalized = ip.toLowerCase();
  if (normalized.includes("%")) return null;

  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split(".").map(Number);
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return null;
    }
    normalized = normalized.slice(0, -dottedTail.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const words = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ].map((word) => (/^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : -1));
  return words.length === 8 && words.every((word) => word >= 0) ? words : null;
}

function isPrivateIpv6(ip: string) {
  const words = ipv6Words(ip);
  if (!words) return true;

  // IPv4-compatible and IPv4-mapped forms can otherwise disguise a private
  // IPv4 destination (for example ::ffff:7f00:1).
  if (
    words.slice(0, 5).every((word) => word === 0) &&
    (words[5] === 0 || words[5] === 0xffff)
  ) {
    const embedded = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateIpv4(embedded);
  }

  const first = words[0];
  // Only globally routable unicast space is useful for user-provided public
  // integrations. This rejects unspecified, loopback, ULA, link-local,
  // multicast, documentation, NAT64, and other special-purpose ranges.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001 && words[1] === 0x0db8) return true; // documentation
  if (first === 0x2001 && words[1] === 0) return true; // Teredo transition
  if (first === 0x2002) return true; // 6to4 transition
  return false;
}

export function isBlockedNetworkAddress(ip: string) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

/**
 * DNS lookup used at socket-connect time for user-controlled destinations.
 * Re-checking here closes the DNS-rebinding window after an earlier URL check.
 */
export const publicNetworkLookup: import("node:net").LookupFunction = (
  hostname,
  options,
  callback,
) => {
  dns.lookup(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isBlockedNetworkAddress(address))
      ) {
        const err = new Error(
          "Remote host resolves to a blocked network address.",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        callback(err, "", 0);
        return;
      }

      if (typeof options === "object" && options.all === true) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      callback(null, first.address, first.family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, "", 0));
};

export async function validatePublicUrl(
  rawUrl: string,
  options: { label?: string; httpsOnly?: boolean } = {},
): Promise<string> {
  const label = options.label ?? "Remote URL";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const allowed = options.httpsOnly
    ? url.protocol === "https:"
    : url.protocol === "http:" || url.protocol === "https:";
  if (!allowed) {
    throw new Error(
      options.httpsOnly
        ? `${label} must use HTTPS.`
        : `${label} must use HTTP or HTTPS.`,
    );
  }
  url.username = "";
  url.password = "";
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    BLOCKED_METADATA_HOSTS.has(hostname)
  ) {
    throw new Error(`${label} points to a blocked host.`);
  }

  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedNetworkAddress(address))
  ) {
    throw new Error(`${label} resolves to a blocked network address.`);
  }
  return url.toString();
}

export const publicNetworkDispatcher = new Agent({
  connect: { lookup: publicNetworkLookup, timeout: 10_000 },
  connections: 8,
  maxResponseSize: 5 * 1024 * 1024,
});

export async function guardedPublicFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  options: { label?: string; httpsOnly?: boolean } = {},
) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  await validatePublicUrl(url, options);
  return fetch(input, {
    ...init,
    redirect: "manual",
    dispatcher: publicNetworkDispatcher,
  } as Parameters<typeof fetch>[1] & { dispatcher: Agent });
}
