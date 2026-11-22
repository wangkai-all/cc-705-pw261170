import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeIndexSuffix,
  encodeIndexValues,
  formatIndexValues,
  hasLengthPrefix,
} from '../shared/indexCodec.js';

const deviceIndex = [{ name: 'demoDeviceIndex', kind: 'integer' }];

const sensorIndex = [
  { name: 'demoSensorSlot', kind: 'integer' },
  { name: 'demoSensorName', kind: 'octets', sizeMin: 1, sizeMax: 24 },
];

const tunnelIndex = [
  { name: 'demoTunnelLocal', kind: 'ipaddress' },
  { name: 'demoTunnelPeer', kind: 'octets', implied: true, sizeMin: 1, sizeMax: 24 },
];

const macIndex = [{ name: 'demoMacAddress', kind: 'octets', sizeMin: 6, sizeMax: 6 }];

const oidIndex = [
  { name: 'slot', kind: 'integer' },
  { name: 'engine', kind: 'oid' },
];

function roundTrip(parts, values) {
  const suffix = encodeIndexValues(parts, values);
  const decoded = decodeIndexSuffix(suffix, parts);
  assert.equal(decoded.ok, true, decoded.error);
  return { suffix, decoded };
}

test('an integer index is one sub-identifier', () => {
  const { suffix, decoded } = roundTrip(deviceIndex, [10]);
  assert.deepEqual(suffix, [10]);
  assert.equal(decoded.values[0].value, 10);
  assert.equal(formatIndexValues(decoded.values, deviceIndex), 'demoDeviceIndex=10');
});

test('a variable-length string index carries a byte length prefix', () => {
  const { suffix, decoded } = roundTrip(sensorIndex, [2, '温度']);
  // Six UTF-8 bytes, even though the string is only two characters.
  assert.deepEqual(suffix, [2, 6, 0xe6, 0xb8, 0xa9, 0xe5, 0xba, 0xa6]);
  assert.equal(decoded.values[1].text, '温度');
  assert.deepEqual(decoded.values[1].bytes, [0xe6, 0xb8, 0xa9, 0xe5, 0xba, 0xa6]);
});

test('fixed-size OCTET STRING and IpAddress indexes have no length prefix', () => {
  assert.equal(hasLengthPrefix({ ...macIndex[0], fixedLength: 6 }, 0, 1), false);
  assert.equal(hasLengthPrefix(tunnelIndex[0], 0, 2), false);

  const { suffix, decoded } = roundTrip(macIndex, [[0x00, 0x11, 0x22, 0x00, 0x33, 0x44]]);
  assert.deepEqual(suffix, [0x00, 0x11, 0x22, 0x00, 0x33, 0x44]);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.values[0].hex, '001122003344');
});

test('an IMPLIED final string index consumes the rest of the suffix', () => {
  const { suffix, decoded } = roundTrip(tunnelIndex, ['192.0.2.10', 'peer-alpha']);
  assert.deepEqual(suffix, [192, 0, 2, 10, ...Array.from(new TextEncoder().encode('peer-alpha'))]);
  assert.equal(decoded.values[0].value, '192.0.2.10');
  assert.equal(decoded.values[1].text, 'peer-alpha');
});

test('an OBJECT IDENTIFIER index uses a length prefix unless IMPLIED', () => {
  const { suffix, decoded } = roundTrip(oidIndex, [3, '1.3.6.1.4.1']);
  assert.deepEqual(suffix, [3, 6, 1, 3, 6, 1, 4, 1]);
  assert.equal(decoded.values[1].value, '1.3.6.1.4.1');
});

test('a suffix too short for its declared string length is rejected', () => {
  const decoded = decodeIndexSuffix([1, 5, 65, 66], sensorIndex);
  assert.equal(decoded.ok, false);
  assert.match(decoded.error, /claims 5 sub-identifier/);
});

test('trailing sub-identifiers after the INDEX clause are rejected', () => {
  const decoded = decodeIndexSuffix([1, 7], deviceIndex);
  assert.equal(decoded.ok, false);
  assert.match(decoded.error, /unexpected trailing/);
});

test('an invalid length or a byte above 255 is rejected', () => {
  assert.equal(decodeIndexSuffix([1, 300, 65], sensorIndex).ok, false);
  assert.match(decodeIndexSuffix([1, 1, 999], sensorIndex).error, /above 255/);
});

test('index values compare correctly when the index is an enumeration', () => {
  const parts = [
    {
      name: 'state',
      kind: 'integer',
      enumeration: { 1: 'up', 2: 'down' },
    },
  ];
  const decoded = decodeIndexSuffix([2], parts);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.values[0].label, 'down');
  assert.equal(formatIndexValues(decoded.values, parts), 'state=down(2)');
});
