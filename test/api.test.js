import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MibRegistry } from '../server/mibRegistry.js';
import { validateCollectRequest, validateControlsPatch } from '../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new MibRegistry(path.join(__dirname, '..', 'mibs')).load();
const target = { host: '127.0.0.1', port: 16161 };

const validBody = () => ({
  table: 'demoDeviceTable',
  columns: ['demoDeviceIndex', 'demoDeviceName'],
  bulkSize: 5,
  agent: { host: '127.0.0.1', port: 16161, community: 'public', timeoutMs: 800, retries: 0 },
});

test('a valid collect request normalises its fields', () => {
  const request = validateCollectRequest(validBody(), registry, target);
  assert.equal(request.table.name, 'demoDeviceTable');
  assert.deepEqual(request.columnNames, ['demoDeviceIndex', 'demoDeviceName']);
  assert.equal(request.bulkSize, 5);
  assert.equal(request.agent.host, '127.0.0.1');
});

test('duplicate column selections collapse to one walk each', () => {
  const body = validBody();
  body.columns = ['demoDeviceName', 'demoDeviceName', 'demoDeviceLoad'];
  const request = validateCollectRequest(body, registry, target);
  assert.deepEqual(request.columnNames, ['demoDeviceName', 'demoDeviceLoad']);
});

test('requests against non-loopback agents are refused', () => {
  for (const host of ['192.0.2.1', 'example.com', '0.0.0.0', '10.0.0.5']) {
    const body = validBody();
    body.agent.host = host;
    assert.throws(() => validateCollectRequest(body, registry, target), /Only loopback agents/, host);
  }
});

test('the default agent target is used when none is supplied', () => {
  const body = validBody();
  delete body.agent;
  const request = validateCollectRequest(body, registry, { host: '127.0.0.1', port: 1161 });
  assert.equal(request.agent.port, 1161);
});

test('unknown tables, foreign columns and unreadable columns are rejected', () => {
  const unknownTable = validBody();
  unknownTable.table = 'nopeTable';
  assert.throws(() => validateCollectRequest(unknownTable, registry, target), /Unknown table/);

  const foreignColumn = validBody();
  foreignColumn.columns = ['demoSensorSlot'];
  assert.throws(() => validateCollectRequest(foreignColumn, registry, target), /does not belong/);

  const empty = validBody();
  empty.columns = [];
  assert.throws(() => validateCollectRequest(empty, registry, target), /at least one column/);
});

test('bulk size and timeout are bounded', () => {
  for (const bulkSize of [0, 51, 1.5, 'many']) {
    const body = validBody();
    body.bulkSize = bulkSize;
    assert.throws(() => validateCollectRequest(body, registry, target), /bulkSize/, String(bulkSize));
  }
  const body = validBody();
  body.agent.timeoutMs = 999999;
  body.agent.retries = 99;
  const request = validateCollectRequest(body, registry, target);
  assert.equal(request.agent.timeoutMs, 10000);
  assert.equal(request.agent.retries, 3);
});

test('control patches are validated against the MIB model', () => {
  assert.deepEqual(validateControlsPatch({ faultMode: 'none' }, registry), { faultMode: 'none' });
  assert.throws(() => validateControlsPatch({ faultMode: 'nope' }, registry), /Unknown fault mode/);
  assert.throws(
    () => validateControlsPatch({ columnFaults: { noSuchColumn: 'timeout' } }, registry),
    /Unknown column/,
  );
  assert.throws(
    () => validateControlsPatch({ holes: { demoDeviceTable: { demoDeviceLoad: [[1, 2]] } } }, registry),
    /length 1/,
  );
  const patch = validateControlsPatch(
    { holes: { demoDeviceTable: { demoDeviceLoad: [[10]] } }, columnFaults: { demoDeviceLoad: 'timeout' } },
    registry,
  );
  assert.deepEqual(patch.holes.demoDeviceTable.demoDeviceLoad, [[10]]);
  assert.deepEqual(patch.columnFaults, { demoDeviceLoad: 'timeout' });
});
