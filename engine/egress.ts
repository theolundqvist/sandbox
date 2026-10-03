import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

/** Builder URLs must never reach the host's launcher, other worlds or the home network; requests go to the checked address so DNS can't swap it. */

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const NAT64 = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

export class EgressError extends Error {}

function ipv4(address: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const bytes = m?.slice(1).map(Number);
  return bytes && bytes.every((b) => b <= 255) ? bytes : null;
}

function ipv6(address: string): number[] | null {
  let text = address.replace(/%.*$/, "");
  if (isIP(text) !== 6) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (tail) {
    const v4 = ipv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, -tail.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.length === 8 ? groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]) : null;
}

function publicV4([a, b, c]: number[]) {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false; // this network, private, loopback, multicast, reserved and broadcast
  if (a === 100 && (b! & 0xc0) === 64) return false; // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && (b! & 0xf0) === 16) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b! & 0xfe) === 18) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Whether an IP address is ordinary public unicast. */
export function publicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4) return publicV4(v4);
  const v6 = ipv6(address);
  if (!v6) return false;
  // NAT64's well-known prefix carries an IPv4 address, and may only carry a public one.
  if (NAT64.every((b, i) => v6[i] === b)) return publicV4(v6.slice(12));
  // Only 2000::/3 is global unicast: that leaves out IPv4-mapped and -compatible, loopback, unique-local, link-local and multicast.
  const [a, b, c, d] = v6;
  if ((a! & 0xe0) !== 0x20) return false;
  if (a === 0x20 && b === 0x01 && (c! & 0xfe) === 0) return false; // 2001::/23 protocol assignments: Teredo, benchmarking, ORCHID
  if (a === 0x20 && b === 0x01 && c === 0x0d && d === 0xb8) return false; // documentation
  if (a === 0x20 && b === 0x02) return false; // 6to4
  if (a === 0x3f && b === 0xff && (c! & 0xf0) === 0) return false; // documentation
  return true;
}

/** Downloads `raw` with GET from public addresses only, up to `limit` bytes. */
export async function download(raw: string, limit: number): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError(`${raw} is not a URL.`);
  }
  if (PROXY_ENV.some((name) => process.env[name])) throw new EgressError("Downloads are off while a network proxy is set.");
  for (let hops = 0; ; hops++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new EgressError("Only http and https URLs can be downloaded.");
    if (url.username || url.password) throw new EgressError("URLs with a password can't be downloaded.");
    const name = url.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
    let found: { address: string; family: number }[];
    try {
      found = isIP(name) ? [{ address: name, family: isIP(name) }] : await lookup(name, { all: true });
    } catch {
      throw new EgressError(`Couldn't find ${name}.`);
    }
    if (!found.length) throw new EgressError(`Couldn't find ${name}.`);
    if (!found.every(({ address }) => publicAddress(address))) throw new EgressError(`${name} is not on the public internet.`);
    const to = (found.find((a) => a.family === 4) ?? found[0]!).address;
    const pinned = new URL(url);
    pinned.hostname = isIP(to) === 6 ? `[${to}]` : to;
    const res = await fetch(pinned, {
      headers: { host: url.host },
      redirect: "manual",
      // A pooled connection is keyed by the address, and could carry this request over another name's TLS session.
      keepalive: false,
      tls:
        url.protocol === "https:"
          ? { ...(isIP(name) ? {} : { serverName: name }), checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert) }
          : undefined,
    }).catch((e: Error) => {
      throw new EgressError(`Download failed: ${e.message}`);
    });
    const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
    if (location !== null) {
      await res.body?.cancel();
      if (hops >= MAX_REDIRECTS) throw new EgressError("Too many redirects.");
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw new EgressError(`Download failed: HTTP ${res.status}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.length;
      if (total > limit) throw new EgressError(`The file is over the ${limit >> 20} MB limit.`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
