import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../server/runStore.js';
import { runToCsv, runToJson } from '../server/exporters.js';

/** A hand-built collector result covering present, missing and not-read cells. */
function sampleResult() {
  return {
    table: { module: 'DEMO-TABLE-MIB', name: 'demoDeviceTable', entryName: 'demoDeviceEntry', oid: '1.3.6.1.4.1.32473.1.1.1' },
    columns: [
      { name: 'demoDeviceIndex', number: 1, oid: '1.3.6.1.4.1.32473.1.1.1.1', baseType: 'Integer32', kind: 'integer', syntaxText: 'Integer32', enumeration: null },
      { name: 'demoDeviceTxBytes', number: 5, oid: '1.3.6.1.4.1.32473.1.1.1.5', baseType: 'Counter64', kind: 'integer', syntaxText: 'Counter64', enumeration: null },
      { name: 'demoDeviceName', number: 2, oid: '1.3.6.1.4.1.32473.1.1.1.2', baseType: 'OCTET STRING', kind: 'octets', syntaxText: 'DisplayString', enumeration: null },
    ],
    indexParts: [{ name: 'demoDeviceIndex', kind: 'integer' }],
    walks: [
      { column: 'demoDeviceIndex', baseOid: '1.3.6.1.4.1.32473.1.1.1.1', requests: 2, varbinds: 3, entries: 3, endReason: 'subtree-crossed', endReasonText: 'next OID left the selected column subtree', normalEnd: true },
      { column: 'demoDeviceName', baseOid: '1.3.6.1.4.1.32473.1.1.1.2', requests: 2, varbinds: 3, entries: 3, endReason: 'subtree-crossed', endReasonText: 'next OID left the selected column subtree', normalEnd: true },
      { column: 'demoDeviceTxBytes', baseOid: '1.3.6.1.4.1.32473.1.1.1.5', requests: 1, varbinds: 2, entries: 2, endReason: 'duplicate-oid', endReasonText: 'agent repeated an OID without advancing', normalEnd: false },
    ],
    rows: [
      {
        rowKey: '1', ordinal: 1, indexOid: '1', indexDisplay: 'demoDeviceIndex=1', indexValues: [{ name: 'demoDeviceIndex', value: 1, display: '1' }],
        indexError: null, status: 'complete', warnings: [],
        cells: {
          demoDeviceIndex: { oid: '1.3.6.1.4.1.32473.1.1.1.1.1', status: 'present', typeName: 'Integer32', valueText: '1', display: '1', enumLabel: null, rawHex: '01' },
          demoDeviceName: { oid: '1.3.6.1.4.1.32473.1.1.1.2.1', status: 'present', typeName: 'OCTET STRING', valueText: 'edge-01', display: 'edge-01', enumLabel: null, rawHex: '656467652d3031' },
          demoDeviceTxBytes: { oid: '1.3.6.1.4.1.32473.1.1.1.5.1', status: 'present', typeName: 'Counter64', valueText: '18446744073709550000', display: '18446744073709550000', enumLabel: null, rawHex: 'ffffffffffffffb0' },
        },
      },
      {
        rowKey: '3', ordinal: 2, indexOid: '3', indexDisplay: 'demoDeviceIndex=3', indexValues: [{ name: 'demoDeviceIndex', value: 3, display: '3' }],
        indexError: null, status: 'partial', warnings: [],
        cells: {
          demoDeviceIndex: { oid: '1.3.6.1.4.1.32473.1.1.1.1.3', status: 'present', typeName: 'Integer32', valueText: '3', display: '3', enumLabel: null, rawHex: '03' },
          demoDeviceName: { oid: '1.3.6.1.4.1.32473.1.1.1.2.3', status: 'present', typeName: 'OCTET STRING', valueText: 'edge-03', display: 'edge-03', enumLabel: null, rawHex: '656467652d3033' },
          demoDeviceTxBytes: { oid: '1.3.6.1.4.1.32473.1.1.1.5.3', status: 'missing', typeName: 'Counter64', valueText: '', display: '', enumLabel: null, rawHex: null },
        },
      },
      {
        rowKey: '10', ordinal: 3, indexOid: '10', indexDisplay: 'demoDeviceIndex=10', indexValues: [{ name: 'demoDeviceIndex', value: 10, display: '10' }],
        indexError: null, status: 'incomplete-walk', warnings: [],
        cells: {
          demoDeviceIndex: { oid: '1.3.6.1.4.1.32473.1.1.1.1.10', status: 'present', typeName: 'Integer32', valueText: '10', display: '10', enumLabel: null, rawHex: '0a' },
          demoDeviceName: { oid: '1.3.6.1.4.1.32473.1.1.1.2.10', status: 'present', typeName: 'OCTET STRING', valueText: 'edge-10', display: 'edge-10', enumLabel: null, rawHex: '656467652d3130' },
          demoDeviceTxBytes: { oid: '1.3.6.1.4.1.32473.1.1.1.5.10', status: 'not-read', typeName: 'Counter64', valueText: '', display: '', enumLabel: null, rawHex: null },
        },
      },
    ],
    summary: {
      status: 'partial', rowCount: 3, completeRows: 1, partialRows: 1, incompleteWalkRows: 1,
      indexErrorRows: 0, presentCells: 7, missingCells: 1, notReadCells: 1,
      requestCount: 5, varbindCount: 8, warnings: ['demoDeviceTxBytes: walk stopped after 1 request(s)'],
      durationMs: 12,
    },
    diagnostics: { host: '127.0.0.1', port: 16161, community: 'public', bulkSize: 4, timeoutMs: 1500, retries: 0, maxRequests: 500, maxVarbinds: 20000, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.012Z', durationMs: 12, warnings: [], notes: [] },
  };
}

test('RunStore round-trips a run, including missing-cell status', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const saved = store.save(sampleResult(), { host: '127.0.0.1', port: 16161 });
  assert.ok(saved.runId > 0);

  const run = store.getRun(saved.runId);
  assert.equal(run.table.name, 'demoDeviceTable');
  assert.equal(run.rows.length, 3);
  assert.equal(run.rows[0].cells.demoDeviceTxBytes.valueText, '18446744073709550000');
  assert.equal(run.rows[1].cells.demoDeviceTxBytes.status, 'missing');
  assert.equal(run.rows[2].cells.demoDeviceTxBytes.status, 'not-read');
  assert.equal(run.rows[2].status, 'incomplete-walk');
  assert.deepEqual(run.indexParts, [{ name: 'demoDeviceIndex', kind: 'integer' }]);
  assert.equal(run.bulkSize, 4);
});

test('listRuns returns newest first, deleteRun cascades', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const first = store.save(sampleResult(), { host: '127.0.0.1', port: 16161 });
  const second = store.save(sampleResult(), { host: '127.0.0.1', port: 16161 });
  assert.deepEqual(store.listRuns().map((run) => run.id), [second.runId, first.runId]);

  assert.equal(store.deleteRun(first.runId), true);
  assert.equal(store.getRun(first.runId), null);
  const orphans = store.db
    .prepare('SELECT COUNT(*) AS n FROM run_cells WHERE run_id = ?')
    .get(first.runId);
  assert.equal(orphans.n, 0, 'cells must be removed with their run');
});

test('CSV export distinguishes present, missing and not-read cells', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const saved = store.save(sampleResult(), { host: '127.0.0.1', port: 16161 });
  const run = store.getRun(saved.runId);
  const csv = runToCsv(run);
  const lines = csv.trimEnd().split('\r\n');
  assert.match(lines[0], /demoDeviceTxBytes\.value,demoDeviceTxBytes\.status,demoDeviceTxBytes\.oid/);
  assert.match(lines[1], /,18446744073709550000,present,1\.3\.6\.1\.4\.1\.32473\.1\.1\.1\.5\.1/);
  assert.match(lines[2], /,,missing,1\.3\.6\.1\.4\.1\.32473\.1\.1\.1\.5\.3/);
  assert.match(lines[3], /,,not-read,1\.3\.6\.1\.4\.1\.32473\.1\.1\.1\.5\.10/);
  assert.match(lines[3], /incomplete-walk/);
});

test('CSV export neutralises formula-looking values', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const result = sampleResult();
  result.rows[0].cells.demoDeviceName.valueText = '=HYPERLINK("http://x")';
  const saved = store.save(result, { host: '127.0.0.1', port: 16161 });
  const csv = runToCsv(store.getRun(saved.runId));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://x"")"'), csv);
});

test('per-column walk metadata survives the store round-trip', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const result = sampleResult();
  result.columns[2].walk = {
    requests: 1, varbinds: 2, entries: 2, endReason: 'duplicate-oid',
    endReasonText: 'agent repeated an OID without advancing', normalEnd: false,
    error: 'OID … already returned',
  };
  const saved = store.save(result, { host: '127.0.0.1', port: 16161 });
  const run = store.getRun(saved.runId);
  assert.equal(run.columns[2].walk.endReason, 'duplicate-oid');
  assert.equal(run.columns[2].walk.normalEnd, false);
  assert.equal(run.walks.length, 3);
  const json = JSON.parse(runToJson(run));
  assert.equal(json.columns[2].walk.error, 'OID … already returned');
});

test('JSON export keeps Counter64 as a decimal string', (t) => {
  const store = new RunStore(':memory:');
  t.after(() => store.close());
  const saved = store.save(sampleResult(), { host: '127.0.0.1', port: 16161 });
  const parsed = JSON.parse(runToJson(store.getRun(saved.runId)));
  assert.equal(parsed.rows[0].cells.demoDeviceTxBytes.value, '18446744073709550000');
  assert.equal(parsed.rows[1].cells.demoDeviceTxBytes.value, null);
  assert.equal(parsed.rows[1].cells.demoDeviceTxBytes.status, 'missing');
  assert.equal(parsed.rows[2].cells.demoDeviceTxBytes.status, 'not-read');
  assert.equal(parsed.run.summary.notReadCells, 1);
});
