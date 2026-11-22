import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRows, collectTable, walkColumn } from '../server/collector.js';
import { compareOids, isPrefix } from '../shared/oids.js';

const ROOT = [1, 3, 6, 1, 4, 1, 4242, 1, 1, 1];

const table = {
  module: 'TEST-MIB',
  name: 'testTable',
  entryName: 'testEntry',
  oid: ROOT.join('.'),
  indexParts: [{ name: 'testIndex', kind: 'integer', baseType: 'Integer32' }],
  columns: [
    { number: 1, name: 'testIndex', oid: [...ROOT, 1].join('.'), baseType: 'Integer32', kind: 'integer', maxAccess: 'read-only', readable: true },
    { number: 2, name: 'testName', oid: [...ROOT, 2].join('.'), baseType: 'OCTET STRING', kind: 'octets', maxAccess: 'read-only', readable: true },
    { number: 3, name: 'testCount', oid: [...ROOT, 3].join('.'), baseType: 'Counter64', kind: 'integer', maxAccess: 'read-only', readable: true },
    { number: 4, name: 'testLoad', oid: [...ROOT, 4].join('.'), baseType: 'Gauge32', kind: 'integer', maxAccess: 'read-only', readable: true },
  ],
};

const column = (name) => table.columns.find((item) => item.name === name);

const EOM = (oid) => ({ oid, type: 130, value: null });
const asOid = (base, suffix = []) => [...base, ...suffix];
const nameOf = (suffix) => ({ oid: asOid([...ROOT, 2], suffix), type: 4, value: Buffer.from(`n${suffix.join('-')}`) });
const countOf = (suffix, decimal) => ({ oid: asOid([...ROOT, 3], suffix), type: 70, value: bigint64(decimal) });
const loadOf = (suffix, n) => ({ oid: asOid([...ROOT, 4], suffix), type: 66, value: n });

function bigint64(decimal) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(decimal));
  return buffer;
}

/**
 * Minimal stand-in for a net-snmp session: `respond(cursor, maxRepetitions)`
 * returns the varbinds for one GETBULK, so each test can script exactly the
 * misbehaviour it is about.
 */
function fakeSession(respond) {
  const calls = [];
  return {
    calls,
    getBulk(oids, nonRepeaters, maxRepetitions, callback) {
      calls.push({ oids, nonRepeaters, maxRepetitions });
      try {
        callback(null, respond(oids[0], maxRepetitions, calls.length));
      } catch (error) {
        callback(error);
      }
    },
    close() {},
  };
}

function fromColumns(instancesByColumn, { eom = true } = {}) {
  return fakeSession((cursor, maxRepetitions) => {
    let pool = [];
    for (const instances of Object.values(instancesByColumn)) {
      if (instances.length && isPrefix(instances[0].oid.slice(0, -1), cursor) === false) continue;
      pool.push(...instances);
    }
    if (!pool.length) pool = Object.values(instancesByColumn).flat();
    const started = cursor.slice();
    const later = pool
      .filter((varbind) => compareOids(varbind.oid, started) > 0)
      .sort((a, b) => compareOids(a.oid, b.oid))
      .slice(0, maxRepetitions);
    if (eom) later.push(EOM(later.length ? later[later.length - 1].oid : started));
    return later;
  });
}

const walk = (session, columnName, extra = {}) =>
  walkColumn({ session, table, column: column(columnName), bulkSize: 3, ...extra });

test('walks advance by instance OID and stop at endOfMibView', async () => {
  const session = fromColumns({ testName: [nameOf([1]), nameOf([2]), nameOf([3])] });
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'end-of-mib');
  assert.equal(state.normalEnd, true);
  assert.deepEqual(state.entries.map((entry) => entry.suffix), [[1], [2], [3]]);
  assert.equal(state.entries[0].value.valueText, 'n1');
});

test('walk stops when the agent crosses the selected subtree', async () => {
  const outside = { oid: [...ROOT, 5, 1], type: 2, value: 7 };
  const session = fakeSession(() => [nameOf([1]), outside]);
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'subtree-crossed');
  assert.equal(state.entries.length, 1);
});

test('walk stops when the agent repeats the last OID', async () => {
  const session = fakeSession(() => [nameOf([1]), nameOf([1])]);
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'duplicate-oid');
  assert.equal(state.entries.length, 1);
  assert.match(state.error, /already returned/);
});

test('walk stops when the agent sends OIDs out of order', async () => {
  let round = 0;
  const session = fakeSession(() => {
    round += 1;
    return round === 1 ? [nameOf([2])] : [nameOf([1])];
  });
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'out-of-order');
  assert.match(state.error, /sorts before previous OID/);
});

test('walk stops when the agent returns no varbinds at all', async () => {
  const session = fakeSession(() => []);
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'no-progress');
  assert.equal(state.entries.length, 0);
});

test('walk stops on a noSuchObject/noSuchInstance varbind', async () => {
  const session = fakeSession(() => [{ oid: [...ROOT, 2], type: 129, value: null }]);
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'no-such-object');
  assert.match(state.error, /NoSuchInstance/);
});

test('walk stops on a timeout instead of retrying forever', async () => {
  const session = fakeSession(() => {
    const error = new Error('Request timed out');
    error.name = 'RequestTimedOutError';
    throw error;
  });
  const state = await walk(session, 'testName');
  assert.equal(state.endReason, 'timeout');
});

test('walk stops when the agent keeps inventing advancing OIDs (request cap)', async () => {
  let counter = 0;
  const session = fakeSession(() => {
    counter += 1;
    return [nameOf([counter])];
  });
  const state = await walk(session, 'testName', { maxRequests: 5 });
  assert.equal(state.endReason, 'request-limit');
  assert.equal(state.requests, 5);
  assert.equal(state.entries.length, 5);
});

test('walk stops at the varbind cap', async () => {
  let counter = 0;
  const session = fakeSession((cursor, maxRepetitions) =>
    Array.from({ length: maxRepetitions }, () => nameOf([(counter += 1)])),
  );
  const state = await walk(session, 'testName', { maxVarbinds: 4, maxRequests: 100 });
  assert.equal(state.endReason, 'varbind-limit');
  assert.equal(state.entries.length, 4);
});

test('Counter64 keeps all 64 bits through the walk', async () => {
  const session = fromColumns({
    testCount: [countOf([1], '18446744073709550000'), countOf([2], '18446744073709551615')],
  });
  const state = await walk(session, 'testCount');
  assert.equal(state.entries[0].value.valueText, '18446744073709550000');
  assert.equal(state.entries[1].value.valueText, '18446744073709551615');
  assert.equal(state.entries[0].value.display, '18446744073709550000');
});

test('rows are keyed by suffix, so a hole in one column never shifts another', () => {
  const walks = [
    {
      column: 'testName',
      normalEnd: true,
      lastOid: null,
      entries: [1, 2, 3].map((n) => ({
        suffix: [n], suffixText: String(n), indexValues: [{ value: n, display: String(n) }],
        indexDisplay: `testIndex=${n}`, indexOk: true, indexError: null,
        value: { valueText: `n${n}`, display: `n${n}` }, oid: asOid([...ROOT, 2], [n]).join('.'),
      })),
    },
    {
      column: 'testCount',
      normalEnd: true,
      lastOid: null,
      entries: [1, 3].map((n) => ({
        suffix: [n], suffixText: String(n), indexValues: [{ value: n, display: String(n) }],
        indexDisplay: `testIndex=${n}`, indexOk: true, indexError: null,
        value: { valueText: String(n * 10), display: String(n * 10) }, oid: asOid([...ROOT, 3], [n]).join('.'),
      })),
    },
  ];
  const { rows } = assembleRows(table, [column('testName'), column('testCount')], walks);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.rowKey), ['1', '2', '3']);
  assert.equal(rows[0].cells.testCount.valueText, '10');
  assert.equal(rows[1].cells.testCount.status, 'missing');
  assert.equal(rows[2].cells.testCount.valueText, '30');
  assert.equal(rows[1].status, 'partial');
});

test('cells past an abnormal end are not-read, not missing', () => {
  const walks = [
    {
      column: 'testName',
      normalEnd: true,
      lastOid: null,
      entries: [1, 2, 3].map((n) => ({
        suffix: [n], suffixText: String(n), indexValues: [{ value: n, display: String(n) }],
        indexDisplay: `testIndex=${n}`, indexOk: true, indexError: null,
        value: { valueText: `n${n}`, display: `n${n}` }, oid: asOid([...ROOT, 2], [n]).join('.'),
      })),
    },
    {
      column: 'testCount',
      normalEnd: false,
      lastOid: [...ROOT, 3, 1].join('.'),
      entries: [1].map((n) => ({
        suffix: [n], suffixText: String(n), indexValues: [{ value: n, display: String(n) }],
        indexDisplay: `testIndex=${n}`, indexOk: true, indexError: null,
        value: { valueText: '10', display: '10' }, oid: asOid([...ROOT, 3], [n]).join('.'),
      })),
    },
  ];
  const { rows } = assembleRows(table, [column('testName'), column('testCount')], walks);
  assert.equal(rows[1].cells.testCount.status, 'not-read');
  assert.equal(rows[2].cells.testCount.status, 'not-read');
  assert.equal(rows[1].status, 'incomplete-walk');
});

test('an undecodable index marks the row index-error instead of dropping it', () => {
  const walks = [
    {
      column: 'testName',
      normalEnd: true,
      lastOid: null,
      entries: [
        {
          suffix: [1, 2], suffixText: '1.2', indexValues: null,
          indexDisplay: '', indexOk: false, indexError: 'unexpected trailing sub-identifier(s)',
          value: { valueText: 'x', display: 'x' }, oid: asOid([...ROOT, 2], [1, 2]).join('.'),
        },
      ],
    },
  ];
  const { rows } = assembleRows(table, [column('testName')], walks);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'index-error');
  assert.match(rows[0].warnings[0], /Index could not be decoded/);
});

test('collectTable refuses columns that are not readable', async () => {
  const locked = {
    ...table,
    columns: table.columns.map((item) =>
      item.name === 'testName' ? { ...item, maxAccess: 'not-accessible', readable: false } : item,
    ),
  };
  await assert.rejects(
    collectTable({
      table: locked,
      columnNames: ['testName'],
      agent: { host: '127.0.0.1', port: 1, community: 'public' },
      bulkSize: 2,
    }),
    /not readable/,
  );
});
