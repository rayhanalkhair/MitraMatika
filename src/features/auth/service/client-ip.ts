import { isIP, isIPv6 } from "node:net";

// The one header Better Auth reads the client address from (advanced.ipAddress.ipAddressHeaders
// lists exactly this). Nothing a client sends under this name is ever believed: the port and the
// route handler overwrite or remove it from the address resolved below.
export const CLIENT_IP_HEADER = "x-mitramatika-client-ip";

// Plain IPv4 or IPv6 only. Ports, brackets, zone ids and lists are rejected, not repaired.
function validIp(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("%")) return undefined;
  return isIP(candidate) === 0 ? undefined : candidate;
}

/**
 * The client address to rate limit by, or undefined (Better Auth then uses its single shared
 * `no-trusted-ip` bucket: fail closed, never a client-chosen key).
 * - On Vercel (`VERCEL` set): only `x-vercel-forwarded-for`, which Vercel sets on every request
 *   and a client cannot supply; its first address, if it is an IP.
 * - Elsewhere: `x-real-ip`, then the RIGHTMOST `x-forwarded-for` address (the one the nearest
 *   proxy appended; the leftmost is whatever the client sent).
 */
export function resolveClientIp(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (env.VERCEL) {
    return validIp(headers.get("x-vercel-forwarded-for")?.split(",")[0]);
  }
  const real = validIp(headers.get("x-real-ip"));
  if (real) return real;
  return validIp(headers.get("x-forwarded-for")?.split(",").at(-1));
}

/** A copy of `headers` whose client IP header is the resolved address, or absent. */
export function withClientIp(
  headers: Headers,
  env?: Readonly<Record<string, string | undefined>>,
): Headers {
  const out = new Headers(headers);
  out.delete(CLIENT_IP_HEADER);
  const ip = resolveClientIp(headers, env);
  if (ip) out.set(CLIENT_IP_HEADER, ip);
  return out;
}

/**
 * The same request with the client IP header set from the resolved address (or removed).
 *
 * Built from the request's PARTS, never `new Request(request, ...)`: under Next on Vercel the
 * incoming request is a NextRequest, a Request subclass that is not this module's global
 * `Request`, and the constructor then either coerces it to the string "[object Request]"
 * ("Failed to parse URL") or fails a private-member brand check. A URL string, an entries list
 * and a buffered body work in every runtime.
 */
export async function requestWithClientIp(
  request: Request,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Request> {
  const headers = withClientIp(new Headers([...request.headers]), env);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
    redirect: "manual",
  });
}

// The eight 16-bit groups of a valid IPv6 address (with "::" expanded and a trailing dotted IPv4
// part turned into two groups), as numbers.
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parts = text.split("::");
  const groups =
    parts.length === 1
      ? text.split(":")
      : (() => {
          const left = parts[0] ? parts[0].split(":") : [];
          const right = parts[1] ? parts[1].split(":") : [];
          const missing = 8 - left.length - right.length;
          return [...left, ...Array<string>(missing).fill("0"), ...right];
        })();
  return groups.map((group) => parseInt(group, 16));
}

/**
 * The subject our own per-IP limits key on (ip-daily-limit.ts, the per-pair email budgets): an IPv4
 * address as it is, an IPv6 address as its /64 network (`2001:db8:1:2::/64`), like Better Auth's
 * own limiter, because one IPv6 host usually holds a whole /64 and could otherwise use a fresh
 * address for every request. An IPv4-mapped IPv6 address counts as the IPv4 address. Anything that
 * is not an IP (the shared no-IP key) is returned unchanged.
 */
export function ipLimitSubject(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}
