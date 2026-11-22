/**
 * RFC 2578 section 7.7 index encoding and decoding.
 *
 * A table row's identity is the sequence of sub-identifiers that follow a
 * column OID. That suffix is *only* interpretable with the table's INDEX
 * clause: fixed-size and IMPLIED OCTET STRINGs carry no length prefix, all
 * other variable-length strings and object identifiers do, IpAddress is
 * always four sub-identifiers, and every integer index is a single
 * sub-identifier. Decoding by position in a GETBULK response instead of by
 * suffix is what turns port 1 of device A into the same row as port 1 of
 * device B; this module exists so the collector never has to do that.
 */

import { compareBytes, describeOctets, ipv4ToString, octetsToDisplay } from './bytes.js';

const KIND = Object.freeze({
  INTEGER: 'integer',
  OCTETS: 'octets',
  OID: 'oid',
  IPADDRESS: 'ipaddress',
});

export { KIND };

/**
 * Normalise one index part coming from the MIB model.
 * @param {object} part
 * @returns {object}
 */
export function normalizeIndexPart(part) {
  const kind = part.kind || KIND.OCTETS;
  const fixedLength =
    Number.isInteger(part.fixedLength) && part.fixedLength > 0
      ? part.fixedLength
      : Number.isInteger(part.sizeMin) && part.sizeMin === part.sizeMax && part.sizeMin > 0
        ? part.sizeMin
        : null;
  const implied = Boolean(part.implied);
  return {
    name: part.name || 'index',
    kind,
    implied,
    fixedLength,
    sizeMin: Number.isInteger(part.sizeMin) ? part.sizeMin : null,
    sizeMax: Number.isInteger(part.sizeMax) ? part.sizeMax : null,
    enumeration: part.enumeration || null,
    baseType: part.baseType || null,
    description: part.description || '',
  };
}

/**
 * Whether an index part carries a leading length sub-identifier.
 * IMPLIED applies to the final part only; a fixed-size string is also
 * encoded without a length prefix (RFC 2578 section 7.7).
 */
export function hasLengthPrefix(part, position, totalParts) {
  if (part.implied && position === totalParts - 1) return false;
  if (part.kind === KIND.IPADDRESS) return false;
  if (part.kind === KIND.INTEGER) return false;
  if (part.fixedLength) return false;
  return true;
}

function partResources(part) {
  if (part.kind === KIND.INTEGER) return 1;
  if (part.kind === KIND.IPADDRESS) return 4;
  return null;
}

function decodeIntegerComponent(component, part) {
  let label = null;
  if (part.enumeration && Object.prototype.hasOwnProperty.call(part.enumeration, String(component))) {
    label = part.enumeration[String(component)];
  }
  return {
    name: part.name,
    kind: part.kind,
    value: component,
    display: label ? `${label}(${component})` : String(component),
    label,
  };
}

function decodeOctetComponents(components, part) {
  const bytes = components.slice();
  const described = describeOctets(bytes);
  return {
    name: part.name,
    kind: part.kind,
    value: described.display,
    bytes,
    hex: described.hex,
    text: described.text,
    display: described.display,
  };
}

/**
 * Decode an instance suffix against the table's index parts.
 *
 * @param {number[]} suffix sub-identifiers after the column OID
 * @param {object[]} rawParts index descriptors from the MIB model
 * @returns {{ok: boolean, values?: object[], error?: string, remaining?: number[]}}
 */
export function decodeIndexSuffix(suffix, rawParts) {
  const parts = rawParts.map(normalizeIndexPart);
  const remaining = Array.from(suffix || [], (n) => Number(n));
  const values = [];

  if (parts.length === 1 && parts[0].implied && remaining.length === 0) {
    // An IMPLIED index of zero length is legal for SIZE(0..n).
    if (parts[0].kind === KIND.OCTETS || parts[0].kind === KIND.OID) {
      values.push(
        parts[0].kind === KIND.OCTETS
          ? decodeOctetComponents([], parts[0])
          : { name: parts[0].name, kind: parts[0].kind, value: '', display: '', components: [] },
      );
      return { ok: true, values };
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const position = i;
    const total = parts.length;

    if (!remaining.length) {
      return { ok: false, error: `Index part ${i + 1} (${part.name}) is missing` };
    }

    if (part.kind === KIND.INTEGER) {
      const component = remaining.shift();
      values.push(decodeIntegerComponent(component, part));
      continue;
    }

    if (part.kind === KIND.IPADDRESS) {
      if (remaining.length < 4) {
        return { ok: false, error: `IpAddress index ${part.name} needs 4 sub-identifiers` };
      }
      const bytes = remaining.splice(0, 4);
      if (bytes.some((b) => b > 255)) {
        return { ok: false, error: `IpAddress index ${part.name} has a byte above 255` };
      }
      const display = ipv4ToString(bytes);
      values.push({ name: part.name, kind: part.kind, value: display, bytes, display });
      continue;
    }

    let length;
    if (part.implied && position === total - 1) {
      length = remaining.length;
    } else if (part.fixedLength) {
      length = part.fixedLength;
    } else {
      length = remaining.shift();
      if (!Number.isInteger(length) || length < 0) {
        return { ok: false, error: `Index ${part.name} has an invalid length sub-identifier` };
      }
    }

    if (remaining.length < length) {
      return {
        ok: false,
        error: `Index ${part.name} claims ${length} sub-identifier(s) but only ${remaining.length} remain`,
      };
    }

    const components = remaining.splice(0, length);
    if (part.kind === KIND.OID) {
      if (components.some((n) => !Number.isInteger(n) || n < 0)) {
        return { ok: false, error: `OID index ${part.name} contains a non-numeric component` };
      }
      const display = components.join('.');
      values.push({ name: part.name, kind: part.kind, value: display, components, display });
    } else {
      if (components.some((n) => n > 255)) {
        return { ok: false, error: `OCTET STRING index ${part.name} contains a value above 255` };
      }
      values.push(decodeOctetComponents(components, part));
    }
  }

  if (remaining.length) {
    return {
      ok: false,
      error: `${remaining.length} unexpected trailing sub-identifier(s) after the index`,
      remaining,
    };
  }
  return { ok: true, values };
}

function encodeOne(part, value, position, total) {
  if (part.kind === KIND.INTEGER) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n)) throw new TypeError(`Index ${part.name} must be an integer`);
    return [n];
  }
  if (part.kind === KIND.IPADDRESS) {
    const text = Array.isArray(value) ? value.join('.') : String(value);
    const bytes = text.split('.').map(Number);
    if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
      throw new TypeError(`Index ${part.name} is not an IPv4 address: ${value}`);
    }
    return bytes;
  }
  if (part.kind === KIND.OID) {
    const text = Array.isArray(value) ? value.join('.') : String(value);
    const components = text.length ? text.split('.').map(Number) : [];
    if (components.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new TypeError(`Index ${part.name} is not an object identifier: ${value}`);
    }
    if (!hasLengthPrefix(part, position, total)) return components;
    return [components.length, ...components];
  }
  let bytes;
  if (Array.isArray(value)) bytes = value.map(Number);
  else if (value instanceof Uint8Array) bytes = Array.from(value);
  else if (typeof value === 'string') bytes = Array.from(new TextEncoder().encode(value));
  else throw new TypeError(`Index ${part.name} needs string bytes`);
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new TypeError(`Index ${part.name} contains a byte outside 0..255`);
  }
  if (part.fixedLength && bytes.length !== part.fixedLength) {
    throw new TypeError(
      `Index ${part.name} must be ${part.fixedLength} octets, got ${bytes.length}`,
    );
  }
  if (!hasLengthPrefix(part, position, total)) return bytes;
  return [bytes.length, ...bytes];
}

/**
 * Encode logical index values into the sub-identifier suffix for an instance.
 * Used by the demo agent and by tests; the UI also uses it to sanity check
 * fixtures.
 */
export function encodeIndexValues(rawParts, values) {
  const parts = rawParts.map(normalizeIndexPart);
  if (!Array.isArray(values) || values.length !== parts.length) {
    throw new TypeError(`Expected ${parts.length} index value(s), got ${values ? values.length : 0}`);
  }
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(...encodeOne(parts[i], values[i], i, parts.length));
  }
  return out;
}

/** Human-readable rendering such as `slot=1, name="cpu-temp"`. */
export function formatIndexValues(values, parts) {
  const descriptors = (parts || []).map(normalizeIndexPart);
  return values
    .map((value, i) => {
      const descriptor = descriptors[i];
      const name = descriptor ? descriptor.name : `index${i + 1}`;
      const kind = value.kind || (descriptor && descriptor.kind);
      const display = value.display ?? String(value.value ?? value);
      if (kind === KIND.OCTETS || kind === KIND.OID) return `${name}="${display}"`;
      return `${name}=${display}`;
    })
    .join(', ');
}

/**
 * Index-order comparison for two decoded index value lists. Compare against
 * the canonical suffix instead whenever it is available; this is a fallback
 * for callers that only kept logical values.
 */
export function compareIndexValues(aValues, bValues, rawParts) {
  const parts = (rawParts || []).map(normalizeIndexPart);
  const length = Math.min(aValues.length, bValues.length);
  for (let i = 0; i < length; i++) {
    const part = parts[i] || {};
    const a = aValues[i];
    const b = bValues[i];
    let cmp;
    if (part.kind === KIND.INTEGER || part.kind === KIND.IPADDRESS) {
      cmp = Number(a.value) - Number(b.value);
    } else if (part.kind === KIND.OID) {
      cmp = compareNumberArrays(a.components || [], b.components || []);
    } else {
      cmp = compareBytes(a.bytes || [], b.bytes || []);
    }
    if (cmp !== 0) return cmp;
  }
  return aValues.length - bValues.length;
}

function compareNumberArrays(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Convenience for UI badges: best-effort single-line display of bytes. */
export function octetsPreview(bytes) {
  return octetsToDisplay(bytes);
}
