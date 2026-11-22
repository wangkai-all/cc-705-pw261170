/**
 * Byte <-> OID sub-identifier conversions used for OCTET STRING and OID
 * indexes (RFC 2578 section 7.7).
 */

export function bytesToOidBytes(bytes) {
  return Array.from(bytes);
}

/**
 * Rendering of OCTET STRING index/key values. Printable ASCII stays readable;
 * everything else is shown as hex. This keeps "sensor-01" readable while
 * accompanying a MAC address with its hex form.
 */
export function octetsToDisplay(bytes) {
  const arr = Array.from(bytes);
  const printable = arr.every((b) => b >= 0x20 && b <= 0x7e);
  if (printable && arr.length > 0) return String.fromCharCode(...arr);
  return '0x' + arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function octetsToUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function isPrintableAscii(bytes) {
  const arr = Array.from(bytes);
  return arr.length > 0 && arr.every((b) => b >= 0x20 && b <= 0x7e);
}

export function utf8ToOctets(text) {
  return Array.from(new TextEncoder().encode(text));
}

export function macToString(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

export function ipv4ToString(bytes) {
  return Array.from(bytes).join('.');
}

export function ipv4ToOctets(text) {
  return String(text)
    .split('.')
    .map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) {
        throw new TypeError(`Invalid IPv4 address: ${text}`);
      }
      return n;
    });
}

/** Render an OID value (object identifier value, not index) as dotted string. */
export function oidValueToString(components) {
  return Array.from(components).join('.');
}

/** Compare two byte arrays lexicographically (RFC 2578 index ordering). */
export function compareBytes(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Decide how an OCTET STRING should be displayed: printable ASCII as text,
 * otherwise valid UTF-8 without control characters as text, otherwise hex.
 * `text` stays null for binary data so callers can tell the difference.
 */
export function describeOctets(bytes) {
  const arr = Array.from(bytes);
  const hex = arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  if (isPrintableAscii(arr)) {
    const ascii = String.fromCharCode(...arr);
    return { display: ascii, text: ascii, hex };
  }
  const utf8 = octetsToUtf8(arr);
  if (utf8 !== null && utf8.length > 0 && !CONTROL_CHARS.test(utf8)) {
    return { display: utf8, text: utf8, hex };
  }
  return { display: '0x' + hex, text: null, hex };
}
