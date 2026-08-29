const net = require('node:net');

const MAX_IPS = 20;

function parseIPv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  if (bytes.some((byte) => byte > 255)) return null;
  return { version: 4, bytes };
}

function parseIPv6(value) {
  let text = value.toLowerCase();

  // Convert an embedded IPv4 tail into its two IPv6 hextets.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIPv4(text.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4.bytes[0] << 8) | ipv4.bytes[1]).toString(16);
    const low = ((ipv4.bytes[2] << 8) | ipv4.bytes[3]).toString(16);
    text = `${text.slice(0, lastColon)}:${high}:${low}`;
  }

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null;

  let groups;
  if (doubleColon >= 0) {
    const left = text.slice(0, doubleColon) ? text.slice(0, doubleColon).split(':') : [];
    const right = text.slice(doubleColon + 2) ? text.slice(doubleColon + 2).split(':') : [];
    if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
        right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = text.split(':');
    if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  }

  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    const value16 = Number.parseInt(group, 16);
    bytes.push((value16 >> 8) & 0xff, value16 & 0xff);
  }

  // Treat IPv4-mapped IPv6 as IPv4 so ::ffff:1.2.3.4 matches 1.2.3.4.
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped
    ? { version: 4, bytes: bytes.slice(12) }
    : { version: 6, bytes };
}

function parseIp(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const version = net.isIP(text);
  if (version === 4) return parseIPv4(text);
  if (version === 6) return parseIPv6(text);
  return null;
}

function parseRule(rule) {
  if (typeof rule !== 'string') return null;
  const text = rule.trim();
  const slash = text.indexOf('/');
  const addressText = slash >= 0 ? text.slice(0, slash) : text;
  const address = parseIp(addressText);
  if (!address) return null;

  let prefix = address.version === 4 ? 32 : 128;
  if (slash >= 0) {
    const prefixText = text.slice(slash + 1);
    if (!/^\d+$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    const max = address.version === 4 ? 32 : 128;
    if (prefix > max) return null;
  }

  return { ...address, prefix };
}

function sameNetwork(candidate, rule) {
  if (candidate.version !== rule.version) return false;
  const fullBytes = Math.floor(rule.prefix / 8);
  const remainingBits = rule.prefix % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (candidate.bytes[index] !== rule.bytes[index]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits) & 0xff;
    if ((candidate.bytes[fullBytes] & mask) !== (rule.bytes[fullBytes] & mask)) return false;
  }
  return true;
}

/** Return true when the client IP is allowed by any exact IP/CIDR rule. */
function ipMatches(clientIp, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  const candidate = parseIp(clientIp);
  if (!candidate) return false;
  return rules.some((rule) => {
    const parsedRule = parseRule(rule);
    return parsedRule ? sameNetwork(candidate, parsedRule) : false;
  });
}

/** Validate the self-service whitelist payload. */
function validateIpList(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'ips must be an array' };
  if (value.length > MAX_IPS) return { ok: false, error: `ips may contain at most ${MAX_IPS} entries` };
  const ips = [];
  for (const item of value) {
    if (typeof item !== 'string' || !parseRule(item)) {
      return { ok: false, error: 'each ips entry must be a valid IP address or CIDR range' };
    }
    ips.push(item.trim());
  }
  return { ok: true, ips };
}

module.exports = { ipMatches, validateIpList, parseIp, parseRule, MAX_IPS };
