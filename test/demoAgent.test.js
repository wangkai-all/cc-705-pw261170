import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MibRegistry } from '../server/mibRegistry.js';
import { DemoAgent } from '../server/demoAgent.js';
import { collectTable } from '../server/collector.js';
import { DEMO_HOLES } from '../server/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = new MibRegistry(path.join(__dirname, '..', 'mibs')).load();
const tables = Array.from(registry.tables.values());

/** Boot the real demo agent on an ephemeral loopback port. */
async function withAgent(t, controls) {
  const state = {
    faultMode: 'none',
    columnFaults: {},
    holes: JSON.parse(JSON.stringify(DEMO_HOLES)),
    community: 'public',
    enabled: true,
    ...controls,
  };
  const agent = new DemoAgent({ tables, getControls: () => state });
  await agent.start({ host: '127.0.0.1', port: 0 });
  t.after(() => agent.stop());
  const target = { host: '127.0.0.1', port: agent.port, community: 'public', timeoutMs: 300, retries: 0 };
  return {
    state,
    agent,
    collect(tableName, columnNames, bulkSize = 4) {
      return collectTable({
        table: registry.getTable(tableName),
        columnNames,
        agent: target,
        bulkSize,
      });
    },
  };
}

const cell = (row, name) => row.cells[name];

test('the MIB directory loads exactly the demo module and its four tables', () => {
  assert.deepEqual(
    registry.modules.map((module) => module.name),
    ['DEMO-TABLE-MIB'],
  );
  assert.deepEqual(
    Array.from(registry.tables.keys()).sort(),
    ['demoDeviceTable', 'demoMacTable', 'demoSensorTable', 'demoTunnelTable'],
  );
});

test('integer-indexed table collects by suffix, with holes preserved', async (t) => {
  const { collect } = await withAgent(t);
  const result = await collect(
    'demoDeviceTable',
    ['demoDeviceIndex', 'demoDeviceName', 'demoDeviceStatus', 'demoDeviceTxBytes'],
  );
  const index = ['1', '3', '10'];
  assert.deepEqual(result.rows.map((row) => row.rowKey), index);
  assert.deepEqual(result.rows.map((row) => cell(row, 'demoDeviceName').valueText), [
    'edge-01',
    'edge-03',
    'edge-10',
  ]);
  // DEMO_HOLES removes TxBytes on indexes 3 and 10; Name must not shift.
  assert.equal(cell(result.rows[1], 'demoDeviceTxBytes').status, 'missing');
  assert.equal(cell(result.rows[2], 'demoDeviceTxBytes').status, 'missing');
  assert.equal(cell(result.rows[1], 'demoDeviceName').status, 'present');
  assert.equal(result.rows[1].status, 'partial');
});

test('Counter64 values keep their full decimal precision', async (t) => {
  const { collect } = await withAgent(t);
  const result = await collect('demoDeviceTable', ['demoDeviceRxBytes']);
  assert.equal(cell(result.rows[0], 'demoDeviceRxBytes').valueText, '18446744073709550000');
  assert.equal(cell(result.rows[1], 'demoDeviceRxBytes').valueText, '999999999999999999');
  assert.equal(cell(result.rows[1], 'demoDeviceRxBytes').typeName, 'Counter64');
});

test('composite string index is decoded from a length prefix, not by position', async (t) => {
  const { collect } = await withAgent(t);
  const result = await collect('demoSensorTable', [
    'demoSensorSlot',
    'demoSensorName',
    'demoSensorValue',
    'demoSensorSamples',
  ]);
  assert.equal(result.rows.length, 5);
  // Ordering is by instance suffix: [2,6,0xe6..] sorts before [2,7,'f'..].
  assert.deepEqual(
    result.rows.map((row) => row.indexDisplay),
    [
      'demoSensorSlot=1, demoSensorName="cpu-temp"',
      'demoSensorSlot=1, demoSensorName="inlet-temp"',
      'demoSensorSlot=2, demoSensorName="温度"',
      'demoSensorSlot=2, demoSensorName="fan-rpm"',
      'demoSensorSlot=7, demoSensorName="psu-current"',
    ],
  );
  const temp = result.rows.find((row) => row.indexValues[1].text === '温度');
  assert.equal(cell(temp, 'demoSensorValue').valueText, '51');
  assert.equal(cell(temp, 'demoSensorName').valueText, '温度');
  // Hole in Samples on the UTF-8 row must not shift the row list.
  assert.equal(cell(temp, 'demoSensorSamples').status, 'missing');
});

test('IpAddress and IMPLIED string index round-trips', async (t) => {
  const { collect } = await withAgent(t);
  const result = await collect('demoTunnelTable', ['demoTunnelLocal', 'demoTunnelPeer', 'demoTunnelLatency']);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(
    result.rows.map((row) => row.indexValues.map((value) => value.value)),
    [
      ['192.0.2.10', 'peer-alpha'],
      ['192.0.2.10', 'peer-beta'],
      ['198.51.100.7', 'peer-gamma'],
    ],
  );
  assert.equal(cell(result.rows[2], 'demoTunnelLatency').valueText, '320');
});

test('fixed-size MAC index survives embedded zero bytes', async (t) => {
  const { collect } = await withAgent(t);
  const result = await collect('demoMacTable', ['demoMacAddress', 'demoMacPort', 'demoMacVlan']);
  assert.equal(result.rows.length, 3);
  const first = result.rows[0];
  assert.equal(first.indexValues[0].hex, '001122003344');
  assert.equal(cell(first, 'demoMacAddress').rawHex, '001122003344');
  assert.equal(cell(first, 'demoMacPort').valueText, 'Gi1/0/1');
  // DEMO_HOLES removes the port of the 02:00:00:00:00:01 row.
  assert.equal(cell(result.rows[1], 'demoMacPort').status, 'missing');
  assert.equal(cell(result.rows[1], 'demoMacAddress').status, 'present');
});

test('hole configured through live controls is applied without restart', async (t) => {
  const { collect, state } = await withAgent(t);
  // With the index column also selected the row itself survives the hole.
  const columns = ['demoDeviceIndex', 'demoDeviceLoad'];
  const before = await collect('demoDeviceTable', columns);
  assert.equal(cell(before.rows[2], 'demoDeviceLoad').valueText, '0');
  state.holes = { ...state.holes, demoDeviceTable: { demoDeviceLoad: [[10]] } };
  const after = await collect('demoDeviceTable', columns);
  assert.equal(after.rows.length, 3);
  assert.equal(cell(after.rows[2], 'demoDeviceLoad').status, 'missing');
  assert.equal(after.rows[2].status, 'partial');
});

test('a per-column fault does not contaminate a neighbouring column', async (t) => {
  const { collect, state } = await withAgent(t);
  state.columnFaults = { demoDeviceStatus: 'error-status' };
  const result = await collect('demoDeviceTable', ['demoDeviceName', 'demoDeviceStatus']);
  const name = result.walks.find((walk) => walk.column === 'demoDeviceName');
  const status = result.walks.find((walk) => walk.column === 'demoDeviceStatus');
  assert.equal(name.endReason, 'subtree-crossed');
  assert.equal(name.entries, 3);
  assert.equal(status.endReason, 'error');
  assert.match(status.error, /GeneralError/);
  assert.equal(cell(result.rows[0], 'demoDeviceName').valueText, 'edge-01');
});

const FAULT_CASES = [
  { mode: 'repeat-last', column: 'demoDeviceStatus', reason: 'duplicate-oid', entries: 1 },
  { mode: 'out-of-order', column: 'demoDeviceStatus', reason: 'out-of-order', entries: 2 },
  { mode: 'no-advance', column: 'demoDeviceLoad', reason: 'no-progress', entries: 0 },
  { mode: 'no-end-of-mib', column: 'demoDeviceStatus', reason: 'duplicate-oid', entries: 3 },
  { mode: 'stop-mid', column: 'demoDeviceStatus', reason: 'end-of-mib', entries: 2 },
  { mode: 'omit-column', column: 'demoDeviceLoad', reason: 'subtree-crossed', entries: 0 },
  { mode: 'error-status', column: 'demoDeviceStatus', reason: 'error', entries: 0 },
];

for (const testCase of FAULT_CASES) {
  test(`fault ${testCase.mode} ends the walk as ${testCase.reason}`, async (t) => {
    const { collect, state } = await withAgent(t);
    state.columnFaults = { [testCase.column]: testCase.mode };
    const result = await collect('demoDeviceTable', [testCase.column], 2);
    const walk = result.walks[0];
    assert.equal(walk.endReason, testCase.reason, walk.error || '');
    assert.equal(walk.entries, testCase.entries);
    assert.ok(walk.requests <= 4, `walk should end promptly, took ${walk.requests} requests`);
  });
}

test('fault timeout is reported, not retried indefinitely', async (t) => {
  const { collect, state } = await withAgent(t);
  state.columnFaults = { demoDeviceLoad: 'timeout' };
  const result = await collect('demoDeviceTable', ['demoDeviceLoad'], 2);
  assert.equal(result.walks[0].endReason, 'timeout');
  assert.equal(result.summary.status, 'partial');
});

test('a global fault applies to every column', async (t) => {
  const { collect, state } = await withAgent(t);
  state.faultMode = 'repeat-last';
  const result = await collect('demoDeviceTable', ['demoDeviceName', 'demoDeviceLoad'], 2);
  assert.deepEqual(result.walks.map((walk) => walk.endReason), ['duplicate-oid', 'duplicate-oid']);
});
