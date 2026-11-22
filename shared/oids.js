/**
 * OID helpers shared by the collector, the demo agent and the browser.
 * Numeric OIDs are always handled as arrays of non-negative integers so that
 * lexicographic comparison is exact - String#localeCompare would order
 * "10" before "9".
 */

export function parseOid(oid) {
  if (Array.isArray(oid)) return oid.map(toComponent);
  if (typeof oid !== 'string' || oid.length === 0) return [];
  return oid.split('.').map(toComponent);
}

function toComponent(part) {
  const n = typeof part === 'number' ? part : Number(String(part).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`Invalid OID component: ${part}`);
  }
  return n;
}

export function oidToString(oid) {
  return (Array.isArray(oid) ? oid : parseOid(oid)).join('.');
}

/** Negative when a < b, positive when a > b, 0 when equal (component-wise). */
export function compareOids(a, b) {
  const left = Array.isArray(a) ? a : parseOid(a);
  const right = Array.isArray(b) ? b : parseOid(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function compareOidStrings(a, b) {
  return compareOids(a, b);
}

export function isPrefix(prefix, oid) {
  const p = Array.isArray(prefix) ? prefix : parseOid(prefix);
  const o = Array.isArray(oid) ? oid : parseOid(oid);
  if (p.length > o.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== o[i]) return false;
  }
  return true;
}

export function isStrictPrefix(prefix, oid) {
  const p = Array.isArray(prefix) ? prefix : parseOid(prefix);
  const o = Array.isArray(oid) ? oid : parseOid(oid);
  return p.length < o.length && isPrefix(p, o);
}

/** Strip a known base OID, returning the remaining sub-identifier array. */
export function subOid(base, oid) {
  const b = Array.isArray(base) ? base : parseOid(base);
  const o = Array.isArray(oid) ? oid : parseOid(oid);
  if (!isPrefix(b, o)) return null;
  return o.slice(b.length);
}

export function joinOid(base, extra) {
  const b = Array.isArray(base) ? base : parseOid(base);
  const e = Array.isArray(extra) ? extra : parseOid(extra);
  return b.concat(e);
}

/**
 * Compare two OIDs in SNMP's "index order". For the integer components that
 * make up table indexes this is plain lexicographic order, which is what
 * RFC 2578 section 7.7 mandates for the response order of a walk.
 */
export function sortOids(oids) {
  return oids.slice().sort(compareOids);
}
