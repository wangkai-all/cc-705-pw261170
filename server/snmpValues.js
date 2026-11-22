/**
 * Value handling for the demo agent and the collector.
 *
 * Counter64 values are kept as decimal strings the whole way through: a JS
 * number loses precision above 2^53 and SNMP counters routinely exceed that.
 * net-snmp hands us Counter64 values as 8-byte Buffers, so the conversion is
 * done with BigInt - never Number.
 */

import { Ber } from 'asn1-ber';
import { describeOctets } from '../shared/bytes.js';

const Writer = Ber.Writer;

export const BER_TAG = {
  Integer: 0x02,
  OctetString: 0x04,
  Null: 0x05,
  OID: 0x06,
  IpAddress: 0x40,
  Counter32: 0x41,
  Gauge32: 0x42,
  TimeTicks: 0x43,
  Opaque: 0x44,
  Counter64: 0x46,
  NoSuchObject: 0x80,
  NoSuchInstance: 0x81,
  EndOfMibView: 0x82,
};

/** SNMP type tag for a MIB column, based on its base syntax. */
export function berTagForColumn(column) {
  const base = (column.baseType || '').toLowerCase();
  if (column.kind === 'ipaddress' || base === 'ipaddress') return BER_TAG.IpAddress;
  if (column.kind === 'oid' || base === 'object identifier') return BER_TAG.OID;
  switch (base) {
    case 'counter32':
    case 'counter':
      return BER_TAG.Counter32;
    case 'gauge32':
    case 'gauge':
    case 'unsigned32':
      return BER_TAG.Gauge32;
    case 'timeticks':
      return BER_TAG.TimeTicks;
    case 'counter64':
      return BER_TAG.Counter64;
    case 'octet string':
    case 'displaystring':
    case 'physaddress':
    case 'macaddress':
    case 'opaque':
      return BER_TAG.OctetString;
    case 'integer':
    case 'integer32':
    case 'truthvalue':
    case 'rowstatus':
    case 'timestamp':
    case 'testandincr':
      return BER_TAG.Integer;
    default:
      if (column.kind === 'integer') return BER_TAG.Integer;
      return BER_TAG.OctetString;
  }
}

export function typeNameForColumn(column) {
  const base = column.baseType;
  if (!base) return column.kind === 'integer' ? 'Integer32' : 'OCTET STRING';
  return base;
}

function toBytes(rawValue) {
  if (Buffer.isBuffer(rawValue)) return rawValue;
  if (rawValue instanceof Uint8Array) return Buffer.from(rawValue);
  if (Array.isArray(rawValue)) return Buffer.from(rawValue);
  if (rawValue && typeof rawValue === 'object' && typeof rawValue.hex === 'string') {
    return Buffer.from(rawValue.hex.replace(/[^0-9a-fA-F]/g, ''), 'hex');
  }
  if (typeof rawValue === 'string') return Buffer.from(rawValue, 'utf8');
  throw new TypeError(`Cannot encode OCTET STRING from ${typeof rawValue}`);
}

function decimalToUint64Buffer(decimal) {
  const text = String(decimal).trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`Counter64 needs a decimal integer, got ${decimal}`);
  const value = BigInt(text);
  if (value < 0n || value > 18446744073709551615n) {
    throw new RangeError(`Counter64 value out of range: ${text}`);
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

/** Encode a logical fixture value with the BER type for its column. */
export function writeColumnValue(writer, column, rawValue) {
  const tag = berTagForColumn(column);
  switch (tag) {
    case BER_TAG.Counter64:
      writer.writeBuffer(decimalToUint64Buffer(rawValue), BER_TAG.Counter64);
      return;
    case BER_TAG.Counter32:
    case BER_TAG.Gauge32:
    case BER_TAG.TimeTicks: {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
        throw new RangeError(`Value for ${column.name} is not an unsigned 32-bit integer: ${rawValue}`);
      }
      writer.writeInt(n, tag);
      return;
    }
    case BER_TAG.Integer: {
      const n = Number(rawValue);
      if (!Number.isInteger(n)) {
        throw new TypeError(`Value for ${column.name} is not an integer: ${rawValue}`);
      }
      writer.writeInt(n, tag);
      return;
    }
    case BER_TAG.OID:
      writer.writeOID(String(rawValue), BER_TAG.OID);
      return;
    case BER_TAG.IpAddress: {
      const octets = String(rawValue)
        .split('.')
        .map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new TypeError(`Value for ${column.name} is not an IPv4 address: ${rawValue}`);
      }
      writer.writeBuffer(Buffer.from(octets), BER_TAG.IpAddress);
      return;
    }
    case BER_TAG.OctetString:
    default:
      writer.writeBuffer(toBytes(rawValue), BER_TAG.OctetString);
  }
}

/** Write a varbind with a Null value (for GET/GETBULK requests and EOM). */
export function writeNullValue(writer, tag) {
  writer.writeByte(tag);
  writer.writeLength(0);
}

/** Write an EndOfMibView varbind value. */
export function writeEndOfMibViewValue(writer) {
  writer.writeByte(BER_TAG.EndOfMibView);
  writer.writeLength(0);
}

/** BER-decode a varbind value as delivered by net-snmp (type is a number). */
export function decodeSnmpVarbind(varbind, column) {
  const type = varbind.type;
  const raw = varbind.value;
  const typeName = type === 70 ? 'Counter64' : typeLabel(type);

  if (type === 70) {
    if (!Buffer.isBuffer(raw)) {
      throw new TypeError('Counter64 varbind was not a Buffer; precision would be lost');
    }
    const decimal = raw.length ? Buffer.from(raw).readBigUInt64BE().toString(10) : '0';
    return {
      typeName: 'Counter64',
      kind: 'integer',
      valueText: decimal,
      display: decimal,
      enumLabel: null,
      rawHex: Buffer.from(raw).toString('hex'),
    };
  }

  if (Buffer.isBuffer(raw)) {
    const bytes = Buffer.from(raw);
    const described = describeOctets(bytes);
    const kind = column && column.kind === 'ipaddress' ? 'ipaddress' : column && column.kind === 'oid' ? 'oid' : 'octets';
    return {
      typeName,
      kind,
      valueText: described.text ?? '0x' + described.hex,
      display: kind === 'octets' ? described.display : '0x' + described.hex,
      enumLabel: null,
      rawHex: described.hex,
    };
  }

  if (typeof raw === 'number') {
    let enumLabel = null;
    if (column && column.enumeration && Object.prototype.hasOwnProperty.call(column.enumeration, String(raw))) {
      enumLabel = column.enumeration[String(raw)];
    }
    const valueText = String(raw);
    let display = valueText;
    if (type === 67) display = `${valueText} (${formatTicks(raw)})`;
    else if (enumLabel) display = `${enumLabel}(${valueText})`;
    return {
      typeName,
      kind: 'integer',
      valueText,
      display,
      enumLabel,
      rawHex: null,
    };
  }

  if (typeof raw === 'string') {
    const valueText = raw;
    let display = raw;
    if (column && column.enumeration && Object.prototype.hasOwnProperty.call(column.enumeration, raw)) {
      display = `${column.enumeration[raw]}(${raw})`;
    }
    return {
      typeName,
      kind: column && column.kind === 'ipaddress' ? 'ipaddress' : 'oid',
      valueText,
      display,
      enumLabel: null,
      rawHex: null,
    };
  }

  if (raw === null || raw === undefined) {
    return { typeName, kind: 'null', valueText: '', display: '', enumLabel: null, rawHex: null };
  }

  return {
    typeName,
    kind: 'other',
    valueText: String(raw),
    display: String(raw),
    enumLabel: null,
    rawHex: null,
  };
}

function typeLabel(type) {
  const map = {
    1: 'Boolean',
    2: 'Integer32',
    3: 'BITS',
    4: 'OCTET STRING',
    6: 'OBJECT IDENTIFIER',
    64: 'IpAddress',
    65: 'Counter32',
    66: 'Gauge32',
    67: 'TimeTicks',
    68: 'Opaque',
    70: 'Counter64',
  };
  return map[type] || `type ${type}`;
}

function formatTicks(ticks) {
  const totalSeconds = Math.floor(Number(ticks) / 100);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
