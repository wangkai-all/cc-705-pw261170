/**
 * Table collector.
 *
 * Every selected column gets its own GETBULK walk. Values are never combined
 * by their position in a response: each instance OID's suffix is decoded
 * against the table's INDEX clause, and that suffix is the row key. A column
 * that stops early therefore produces holes in the affected rows instead of
 * shifting the remaining values onto the wrong device.
 *
 * Walk termination is explicit. Besides the normal "crossed the subtree" and
 * endOfMibView cases, the collector stops a column when an agent repeats an
 * OID, returns OIDs out of order, or otherwise fails to advance, and records
 * the reason. Request and varbind caps guarantee termination even against an
 * agent that keeps inventing data.
 */

import * as snmp from 'net-snmp';
import { compareOids, isPrefix, subOid } from '../shared/oids.js';
import { decodeIndexSuffix, formatIndexValues } from '../shared/indexCodec.js';
import { decodeSnmpVarbind } from './snmpValues.js';

export const REASON_TEXT = {
  'end-of-mib': 'agent returned endOfMibView',
  'subtree-crossed': 'next OID left the selected column subtree',
  'duplicate-oid': 'agent repeated an OID without advancing',
  'out-of-order': 'agent returned an OID earlier than the previous one',
  'no-progress': 'agent returned no varbind for the column',
  'no-such-object': 'agent reported noSuchObject/noSuchInstance',
  'request-limit': 'request limit reached before the column ended',
  'varbind-limit': 'varbind limit reached before the column ended',
  timeout: 'request timed out',
  error: 'request failed',
};

const NORMAL_END = new Set(['end-of-mib', 'subtree-crossed', 'no-such-object']);

export function createSnmpSession(options) {
  return snmp.createSession(options.host, options.community || 'public', {
    version: snmp.Version2c,
    port: options.port,
    timeout: options.timeoutMs ?? 1500,
    retries: options.retries ?? 1,
    transport: 'udp4',
    backwardsGetNexts: true,
    reportOidMismatchErrors: false,
  });
}

function getBulkOnce(session, oid, maxRepetitions) {
  return new Promise((resolve, reject) => {
    session.getBulk([oid], 0, maxRepetitions, (error, varbinds) => {
      if (error) reject(error);
      else resolve(varbinds.flat());
    });
  });
}

function endWalk(state, reason, extra = {}) {
  state.endReason = reason;
  state.endReasonText = REASON_TEXT[reason] || String(reason);
  Object.assign(state, extra);
  state.done = true;
}

/**
 * Walk one column.
 *
 * @param {object} params
 * @param {import('net-snmp').Session} params.session
 * @param {object} params.table table model
 * @param {object} params.column column model
 * @param {number} params.bulkSize
 * @param {number} params.maxRequests
 * @param {number} params.maxVarbinds
 */
export async function walkColumn({ session, table, column, bulkSize, maxRequests = 500, maxVarbinds = 20000 }) {
  const state = {
    column: column.name,
    oid: column.oid,
    requests: 0,
    varbinds: 0,
    entries: [],
    lastOid: null,
    endReason: null,
    endReasonText: '',
    endOid: null,
    error: null,
    done: false,
    normalEnd: false,
  };

  while (!state.done) {
    if (state.requests >= maxRequests) {
      endWalk(state, 'request-limit');
      break;
    }
    if (state.varbinds >= maxVarbinds) {
      endWalk(state, 'varbind-limit');
      break;
    }

    state.requests += 1;
    const cursor = state.lastOid || column.oid;
    let varbinds;
    try {
      varbinds = await getBulkOnce(session, cursor, bulkSize);
    } catch (error) {
      endWalk(state, error && error.name === 'RequestTimedOutError' ? 'timeout' : 'error', {
        error: error && error.message ? error.message : String(error),
        endOid: state.lastOid,
      });
      break;
    }

    state.varbinds += varbinds.length;
    if (!varbinds.length) {
      endWalk(state, 'no-progress', { endOid: state.lastOid });
      break;
    }

    let accepted = 0;
    for (const varbind of varbinds) {
      if (state.done) break;
      if (state.entries.length >= maxVarbinds) {
        // Checked per varbind, not per response: one oversized GETBULK must
        // not push the collected set past the cap.
        endWalk(state, 'varbind-limit', { endOid: state.lastOid });
        break;
      }
      const oid = varbind.oid;

      if (snmp.isVarbindError(varbind)) {
        if (varbind.type === snmp.ObjectType.EndOfMibView) {
          endWalk(state, 'end-of-mib', { endOid: oid });
          break;
        }
        endWalk(state, 'no-such-object', {
          endOid: oid,
          error: snmp.varbindError(varbind),
        });
        break;
      }

      const inside = isPrefix(column.oid, oid);
      const comparison = state.lastOid === null ? 1 : compareOids(oid, state.lastOid);

      if (!inside) {
        if (comparison <= 0) {
          endWalk(state, comparison === 0 ? 'duplicate-oid' : 'out-of-order', {
            endOid: oid,
            error: `response OID ${oid} is outside ${column.oid} and does not follow the last OID ${
              state.lastOid || '(none)'
            }`,
          });
        } else {
          endWalk(state, 'subtree-crossed', { endOid: oid });
        }
        break;
      }

      if (comparison <= 0) {
        endWalk(state, comparison === 0 ? 'duplicate-oid' : 'out-of-order', {
          endOid: oid,
          error:
            comparison === 0
              ? `OID ${oid} was already returned for this column (cursor ${cursor})`
              : `OID ${oid} sorts before previous OID ${state.lastOid}`,
        });
        break;
      }

      const suffix = subOid(column.oid, oid) || [];
      const decoded = decodeIndexSuffix(suffix, table.indexParts);
      const value = decodeSnmpVarbind(varbind, column);
      state.entries.push({
        oid,
        suffix,
        suffixText: suffix.join('.'),
        indexOk: decoded.ok,
        indexError: decoded.ok ? null : decoded.error,
        indexValues: decoded.ok ? decoded.values : null,
        indexDisplay: decoded.ok ? formatIndexValues(decoded.values, table.indexParts) : '',
        value,
        requestNo: state.requests,
      });
      state.lastOid = oid;
      accepted += 1;
    }

    if (state.done) break;
    if (!accepted) {
      endWalk(state, 'no-progress', { endOid: state.lastOid });
      break;
    }
    // A full response may contain exactly the requested repetitions; if the
    // agent returns more, we still continue from the last accepted OID.
  }

  state.normalEnd = NORMAL_END.has(state.endReason);
  return state;
}

function cellForMissing(column, suffix) {
  return {
    oid: [column.oid, ...suffix].join('.'),
    type: column.baseType || null,
    valueText: '',
    display: '',
    enumLabel: null,
    rawHex: null,
    status: 'missing',
  };
}

function classifyMissingCell(walk, column, suffix) {
  const cell = cellForMissing(column, suffix);
  if (walk.normalEnd) {
    cell.status = 'missing';
    return cell;
  }
  const expectedOid = cell.oid;
  if (walk.lastOid && compareOids(expectedOid, walk.lastOid) > 0) {
    cell.status = 'not-read';
  } else {
    cell.status = 'missing';
  }
  return cell;
}

/**
 * Assemble rows from per-column walks. The union of instance suffixes is the
 * row set; no column is assumed to have the same number of entries as another.
 */
export function assembleRows(table, columns, walks) {
  const rowMap = new Map();
  const duplicateInstances = [];

  for (const walk of walks) {
    const column = columns.find((item) => item.name === walk.column);
    if (!column) continue;
    const seenSuffixes = new Set();
    for (const entry of walk.entries) {
      const key = entry.suffixText;
      if (seenSuffixes.has(key)) {
        duplicateInstances.push({ column: column.name, oid: entry.oid });
        continue;
      }
      seenSuffixes.add(key);
      let row = rowMap.get(key);
      if (!row) {
        row = {
          rowKey: key,
          indexOid: key,
          indexValues: entry.indexValues,
          indexDisplay: entry.indexDisplay,
          indexError: entry.indexError,
          suffix: entry.suffix,
          cells: {},
          warnings: [],
        };
        rowMap.set(key, row);
      } else {
        if (!row.indexValues && entry.indexValues) {
          row.indexValues = entry.indexValues;
          row.indexDisplay = entry.indexDisplay;
        }
        if (!row.indexError && entry.indexError) row.indexError = entry.indexError;
      }
      row.cells[column.name] = {
        ...entry.value,
        oid: entry.oid,
        status: 'present',
        requestNo: entry.requestNo,
      };
    }
  }

  for (const row of rowMap.values()) {
    for (const column of columns) {
      if (row.cells[column.name]) continue;
      const walk = walks.find((item) => item.column === column.name);
      row.cells[column.name] = walk
        ? classifyMissingCell(walk, column, row.suffix)
        : { ...cellForMissing(column, row.suffix), status: 'not-read' };
    }
    if (row.indexError) {
      row.status = 'index-error';
      row.warnings.push(`Index could not be decoded: ${row.indexError}`);
    } else {
      const statuses = Object.values(row.cells).map((cell) => cell.status);
      if (statuses.includes('not-read')) row.status = 'incomplete-walk';
      else if (statuses.includes('missing')) row.status = 'partial';
      else row.status = 'complete';
    }
  }

  const rows = Array.from(rowMap.values()).sort((a, b) => compareOids(a.suffix, b.suffix));
  rows.forEach((row, index) => {
    row.ordinal = index + 1;
  });

  return { rows, duplicateInstances };
}

export function summarise(table, columns, walks, rows, extras = {}) {
  const statuses = rows.map((row) => row.status);
  const cellStatuses = rows.flatMap((row) => Object.values(row.cells).map((cell) => cell.status));
  const abnormalWalks = walks.filter((walk) => !walk.normalEnd);
  const warnings = [];
  for (const walk of abnormalWalks) {
    warnings.push(
      `${walk.column}: walk stopped after ${walk.requests} request(s) - ${walk.endReasonText}` +
        (walk.error ? ` (${walk.error})` : ''),
    );
  }
  for (const duplicate of extras.duplicateInstances || []) {
    warnings.push(`${duplicate.column}: duplicate instance ${duplicate.oid} ignored`);
  }
  const unparsed = rows.filter((row) => row.status === 'index-error').length;
  if (unparsed) warnings.push(`${unparsed} row(s) had an index suffix that did not match the INDEX clause`);

  return {
    status: abnormalWalks.length ? 'partial' : 'ok',
    rowCount: rows.length,
    completeRows: statuses.filter((status) => status === 'complete').length,
    partialRows: statuses.filter((status) => status === 'partial').length,
    incompleteWalkRows: statuses.filter((status) => status === 'incomplete-walk').length,
    indexErrorRows: statuses.filter((status) => status === 'index-error').length,
    presentCells: cellStatuses.filter((status) => status === 'present').length,
    missingCells: cellStatuses.filter((status) => status === 'missing').length,
    notReadCells: cellStatuses.filter((status) => status === 'not-read').length,
    requestCount: walks.reduce((sum, walk) => sum + walk.requests, 0),
    varbindCount: walks.reduce((sum, walk) => sum + walk.varbinds, 0),
    warnings,
    ...extras,
  };
}

/**
 * Run a full collection. Returns the serialisable result plus walk states.
 *
 * @param {object} params
 * @param {object} params.table table model
 * @param {string[]} params.columnNames
 * @param {object} params.agent {host, port, community, timeoutMs, retries}
 * @param {number} params.bulkSize
 * @param {object} [params.session] injectable session (tests)
 */
export async function collectTable({ table, columnNames, agent, bulkSize = 10, session: injectedSession }) {
  const columns = columnNames
    .map((name) => table.columns.find((column) => column.name === name))
    .filter(Boolean);
  if (!columns.length) throw new Error('Select at least one readable column');

  const unreadable = columns.filter((column) => column.readable === false);
  if (unreadable.length) {
    throw new Error(`Columns not readable by SNMP: ${unreadable.map((column) => column.name).join(', ')}`);
  }

  const maxRequests = 500;
  const maxVarbinds = 20000;
  const startedAt = Date.now();
  const session = injectedSession || createSnmpSession(agent);
  const walks = [];
  try {
    for (const column of columns) {
      const walk = await walkColumn({
        session,
        table,
        column,
        bulkSize,
        maxRequests,
        maxVarbinds,
      });
      walks.push(walk);
    }
  } finally {
    if (!injectedSession) session.close();
  }

  const { rows, duplicateInstances } = assembleRows(table, columns, walks);
  const durationMs = Date.now() - startedAt;
  const summary = summarise(table, columns, walks, rows, { duplicateInstances, durationMs });
  const diagnostics = {
    host: agent.host,
    port: agent.port,
    community: agent.community || 'public',
    bulkSize,
    timeoutMs: agent.timeoutMs ?? 1500,
    retries: agent.retries ?? 1,
    maxRequests,
    maxVarbinds,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    warnings: summary.warnings,
    notes: [
      'Rows are keyed by the decoded instance suffix of each column, never by response position.',
      'Counter64 values are decimal strings so the full 64-bit precision survives.',
    ],
  };

  return {
    table: {
      module: table.module,
      name: table.name,
      entryName: table.entryName,
      oid: table.oid,
    },
    columns: columns.map((column) => {
      const walk = walks.find((item) => item.column === column.name);
      return {
        name: column.name,
        number: column.number,
        oid: column.oid,
        baseType: column.baseType,
        kind: column.kind,
        syntaxText: column.syntaxText,
        enumeration: column.enumeration,
        walk: walk
          ? {
              requests: walk.requests,
              varbinds: walk.varbinds,
              entries: walk.entries.length,
              endReason: walk.endReason,
              endReasonText: walk.endReasonText,
              endOid: walk.endOid,
              normalEnd: walk.normalEnd,
              error: walk.error,
            }
          : null,
      };
    }),
    indexParts: table.indexParts,
    walks: walks.map((walk) => ({
      column: walk.column,
      baseOid: walk.oid,
      requests: walk.requests,
      varbinds: walk.varbinds,
      entries: walk.entries.length,
      endReason: walk.endReason,
      endReasonText: walk.endReasonText,
      endOid: walk.endOid,
      lastOid: walk.lastOid,
      normalEnd: walk.normalEnd,
      error: walk.error,
    })),
    rows,
    summary,
    diagnostics,
  };
}
