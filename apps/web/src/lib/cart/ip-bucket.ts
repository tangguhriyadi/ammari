import { isIP } from "node:net";

/** The rate-limit bucket for a client address (security review, session 8): an IPv4 address as is,
 * an IPv6 address as its /64 network (`2001:db8:1:2::`). One IPv6 client normally holds a whole
 * /64, so keying on the full address would let it rotate through billions of "different" clients
 * and never hit a per-IP limit. An IPv4-mapped IPv6 address (`::ffff:203.0.113.5`) is its IPv4.
 * Returns null for anything that is not an IP address. */
export function rateLimitBucketForIp(ip: string): string | null {
  const value = ip.trim();
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];

  // Strip a zone id ("fe80::1%eth0"), turn a trailing dotted IPv4 into two hextets, expand "::".
  let address = value.split("%")[0] ?? value;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    address = `${address.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const hextets = tail !== undefined ? [...headParts, ...Array<string>(missing).fill("0"), ...tailParts] : headParts;
  if (hextets.length !== 8) return null;
  const network = hextets.slice(0, 4).map((part) => parseInt(part, 16).toString(16));
  return `${network.join(":")}::`;
}
