/**
 * Local demo SNMP agent (SNMPv2c, GET / GETNEXT / GETBULK).
 *
 * Built directly on asn1-ber rather than net-snmp's provider registry because
 * the demo must be able to answer *badly*: repeat the last OID, send OIDs
 * backwards, return an empty varbind list, keep walking past a subtree, stop
 * early, drop a request or return an error-status. A well-behaved agent
 * library offers no hook for those, and the point of this project is to show
 * the collector noticing them.
 *
 * The instance space is rebuilt on every request from the fixture rows and the
 * live demo controls (holes, faults, bulk size), so UI changes take effect
 * without restarting the socket. Loopback only.
 */

import dgram from 'node:dgram';
import { Ber } from 'asn1-ber';
import { compareOids, isPrefix, parseOid } from '../shared/oids.js';
import { encodeIndexValues } from '../shared/indexCodec.js';
import { BER_TAG, writeColumnValue, writeEndOfMibViewValue, writeNullValue } from './snmpValues.js';
import { DEMO_ROWS } from './fixtures.js';

const Reader = Ber.Reader;
const Writer = Ber.Writer;

export const PDU_TYPE = {
  GetRequest: 0xa0,
  GetNextRequest: 0xa1,
  GetResponse: 0xa2,
  SetRequest: 0xa3,
  GetBulkRequest: 0xa5,
};

const GEN_ERR = 5;

function sameIndexList(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Build sorted instance OIDs for one column, minus the configured holes. */
export function buildColumnInstances(table, column, rows, holes) {
  const hidden = (holes || []).map((index) => JSON.stringify(index));
  const instances = [];
  for (const row of rows) {
    if (hidden.includes(JSON.stringify(row.index))) continue;
    const value = row.cells[column.name];
    if (value === undefined) continue;
    let suffix;
    try {
      suffix = encodeIndexValues(table.indexParts, row.index);
    } catch (error) {
      // A malformed fixture must not take the whole agent down.
      console.error(`[demo-agent] cannot encode row ${JSON.stringify(row.index)} of ${table.name}: ${error.message}`);
      continue;
    }
    instances.push({
      table,
      column,
      row,
      oid: [...parseOid(column.oid), ...suffix],
      value,
    });
  }
  instances.sort((a, b) => compareOids(a.oid, b.oid));
  return instances;
}

export class DemoAgent {
  /**
   * @param {object} params
   * @param {object[]} params.tables table models from the MIB loader
   * @param {() => object} [params.getControls] live controls snapshot
   * @param {(event: object) => void} [params.onRequest] request log hook
   */
  constructor({ tables, getControls, onRequest }) {
    this.tables = tables;
    this.getControls = getControls || (() => ({}));
    this.onRequest = onRequest || null;
    this.socket = null;
    this.port = null;
    this.address = null;
    this.running = false;
    this.requestCount = 0;
    this.clientState = new Map();
  }

  controls() {
    const controls = this.getControls() || {};
    return {
      community: controls.community || 'public',
      enabled: controls.enabled !== false,
      faultMode: controls.faultMode || 'none',
      columnFaults: controls.columnFaults || {},
      holes: controls.holes || {},
      maxResponseSize: controls.maxResponseSize || 1400,
    };
  }

  holesFor(table, column) {
    const controls = this.controls();
    const byTable = controls.holes[table.name] || {};
    return byTable[column.name] || [];
  }

  instancesFor(table, column) {
    return buildColumnInstances(table, column, DEMO_ROWS[table.name] || [], this.holesFor(table, column));
  }

  /** Every instance in the whole demo MIB, sorted. */
  allInstances() {
    const list = [];
    for (const table of this.tables) {
      for (const column of table.columns) {
        list.push(...this.instancesFor(table, column));
      }
    }
    list.sort((a, b) => compareOids(a.oid, b.oid));
    return list;
  }

  start({ host = '127.0.0.1', port = 16161 } = {}) {
    if (this.running) return Promise.resolve(this);
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buffer, rinfo) => this.handleDatagram(buffer, rinfo));
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.socket.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.socket.removeListener('error', onError);
        const address = this.socket.address();
        this.address = address.address;
        this.port = address.port;
        this.running = true;
        resolve(this);
      };
      this.socket.once('error', onError);
      this.socket.once('listening', onListening);
      this.socket.bind(port, host);
    });
  }

  stop() {
    if (!this.socket) return Promise.resolve();
    this.running = false;
    return new Promise((resolve) => {
      this.socket.close(() => {
        this.socket = null;
        resolve();
      });
    });
  }

  handleDatagram(buffer, rinfo) {
    const controls = this.controls();
    if (!controls.enabled) return;

    let message;
    try {
      message = decodeSnmpRequest(buffer);
    } catch {
      return; // malformed: nothing sensible to answer
    }
    if (!message) return;
    if (message.version !== 1) return; // only SNMPv2c
    if (message.community !== controls.community) return;

    const clientKey = `${rinfo.address}:${rinfo.port}`;
    const context = this.clientContext(clientKey);

    if (message.pdu.type === PDU_TYPE.SetRequest) {
      this.send(
        encodeResponse(message, [{ oid: message.pdu.varbinds[0]?.oid || [0], type: BER_TAG.Null }], GEN_ERR, 1),
        rinfo,
      );
      return;
    }
    if (![PDU_TYPE.GetRequest, PDU_TYPE.GetNextRequest, PDU_TYPE.GetBulkRequest].includes(message.pdu.type)) {
      return;
    }

    if (this.requestFault(message, controls) === 'timeout') {
      this.log({ kind: 'dropped', pduType: pduTypeName(message.pdu.type), reason: 'injected timeout', client: clientKey });
      return;
    }

    this.requestCount += 1;
    const started = Date.now();
    let response;
    if (message.pdu.type === PDU_TYPE.GetRequest) {
      response = this.handleGet(message, controls, context);
    } else if (message.pdu.type === PDU_TYPE.GetNextRequest) {
      response = this.handleGetNext(message, controls, context);
    } else {
      response = this.handleGetBulk(message, controls, context);
    }

    if (response) {
      this.send(response, rinfo);
      this.log({
        kind: pduTypeName(message.pdu.type),
        client: clientKey,
        request: message.pdu.varbinds.map((varbind) => varbind.oid.join('.')),
        returned: response.varbindCount,
        errorStatus: response.errorStatus,
        durationMs: Date.now() - started,
      });
    }
  }

  clientContext(key) {
    let context = this.clientState.get(key);
    if (!context) {
      context = { faultState: null };
      this.clientState.set(key, context);
    }
    return context;
  }

  /**
   * The column whose subtree contains `cursor`, or null.
   *
   * A fault belongs to a column only while the request actually addresses that
   * column. There is deliberately no fallback to a previously seen column:
   * otherwise a fault configured for one column would also corrupt the walk of
   * its neighbours.
   */
  columnAt(cursor) {
    for (const table of this.tables) {
      for (const column of table.columns) {
        if (isPrefix(parseOid(column.oid), cursor)) return { table, column };
      }
    }
    return null;
  }

  /** The exact instance at `oid`, if any. */
  instanceAt(oid) {
    const location = this.columnAt(oid);
    if (!location) return null;
    const instances = this.instancesFor(location.table, location.column);
    return instances.find((instance) => compareOids(instance.oid, oid) === 0) || null;
  }

  /** First / last served instance of a column (instance space after holes). */
  edgeInstance(column, which) {
    for (const table of this.tables) {
      if (!table.columns.some((item) => item.name === column.name)) continue;
      const instances = this.instancesFor(table, column);
      return (which === 'last' ? instances[instances.length - 1] : instances[0]) || null;
    }
    return null;
  }

  faultFor(column, controls) {
    if (!column) return controls.faultMode;
    const perColumn = controls.columnFaults[column.name];
    if (perColumn && perColumn !== 'inherit') return perColumn;
    return controls.faultMode;
  }

  /**
   * The fault that governs a whole request (only used for dropped packets,
   * where there is no response to carry a per-varbind status).
   */
  requestFault(message, controls) {
    const first = message.pdu.varbinds[0]?.oid;
    if (!first) return controls.faultMode;
    const instance = message.pdu.type === PDU_TYPE.GetRequest ? this.instanceAt(first) : null;
    const location = instance ? this.columnAt(instance.oid) : this.columnAt(first);
    if (!location) return controls.faultMode;
    return this.faultFor(location.column, controls);
  }

  faultStateFor(context, column) {
    if (!context.faultState || context.faultState.column !== (column && column.name)) {
      context.faultState = {
        column: column ? column.name : null,
        served: 0,
        lastVarbind: null,
      };
    }
    return context.faultState;
  }

  /** Find the first instance strictly after `cursor`, optionally skipping a column. */
  nextInstance(cursor, { skipColumn } = {}) {
    const all = this.allInstances();
    for (const instance of all) {
      if (compareOids(instance.oid, cursor) <= 0) continue;
      if (skipColumn && instance.column.name === skipColumn) continue;
      return instance;
    }
    return null;
  }

  varbindFor(instance) {
    return {
      oid: instance.oid.slice(),
      type: 'value',
      column: instance.column,
      value: instance.value,
    };
  }

  eomVarbind(oid) {
    return { oid: oid.slice(), type: BER_TAG.EndOfMibView };
  }

  /** Remembers the last varbind served to a client, for fault modes. */
  remember(context, column, varbind) {
    const faultState = this.faultStateFor(context, column);
    faultState.lastVarbind = JSON.parse(JSON.stringify(varbind));
    return faultState;
  }

  /**
   * One GETNEXT step. Returns `{ varbind, nextCursor, served }` or
   * `{ fatal: {errorStatus} }` that the caller turns into an error response.
   *
   * `served` reports whether this step returned a real instance of the column
   * the cursor was addressing; fault modes use it to decide when to misbehave.
   */
  step(cursor, controls, context, location) {
    const column = location ? location.column : null;
    const fault = this.faultFor(column, controls);
    const faultState = this.faultStateFor(context, column);

    if (fault === 'error-status') {
      return { fatal: { errorStatus: GEN_ERR, errorIndex: 1 }, varbind: null };
    }
    if (fault === 'no-advance' && faultState.served >= 1) {
      // An empty varbind list is not representable per varbind; the bulk
      // handler emits no varbinds at all. For GETNEXT, endOfMibView stands in.
      return { varbind: this.eomVarbind(cursor), nextCursor: cursor };
    }

    const skipColumn = column && fault === 'omit-column' ? column.name : null;
    const next = this.nextInstance(cursor, { skipColumn });

    if (!next) {
      return { varbind: this.eomVarbind(cursor), nextCursor: cursor };
    }

    if (column && next.column.name !== column.name && fault === 'no-end-of-mib') {
      // The walk has left the column but the agent pretends it has not: serve
      // the column's last instance forever.
      const last = this.edgeInstance(column, 'last');
      if (last) {
        const repeat = this.varbindFor(last);
        this.remember(context, column, repeat);
        return { varbind: repeat, nextCursor: repeat.oid };
      }
    }

    if (fault === 'stop-mid' && column && faultState.served >= 1 &&
        (faultState.served >= 2 || next.column.name !== column.name)) {
      // End the column after two instances, or after one if the subtree
      // happens to contain only a single instance because of holes.
      return { varbind: this.eomVarbind(cursor), nextCursor: cursor };
    }

    if (fault === 'repeat-last' && faultState.lastVarbind && next.column.name === column?.name) {
      const repeat = JSON.parse(JSON.stringify(faultState.lastVarbind));
      return { varbind: repeat, nextCursor: repeat.oid };
    }

    if (fault === 'out-of-order' && faultState.served >= 2 && next.column.name === column?.name) {
      // Two instances have been served in order; now answer with the column's
      // first instance again. That OID is lower than the latest one, which is
      // what an agent with a broken instance ordering looks like.
      const first = this.edgeInstance(column, 'first');
      if (first && compareOids(first.oid, cursor) < 0) {
        return { varbind: this.varbindFor(first), nextCursor: first.oid };
      }
    }

    const servedColumn = next.column.name === (column && column.name);
    const varbind = this.varbindFor(next);
    if (servedColumn) faultState.served += 1;
    this.remember(context, column, varbind);
    return { varbind, nextCursor: varbind.oid, served: servedColumn };
  }

  handleGet(message, controls, context) {
    const out = [];
    let errorStatus = 0;
    let errorIndex = 0;
    message.pdu.varbinds.forEach((varbind, index) => {
      const instance = this.instanceAt(varbind.oid);
      const fault = instance ? this.faultFor(instance.column, controls) : controls.faultMode;
      if (fault === 'error-status' && !errorStatus) {
        errorStatus = GEN_ERR;
        errorIndex = index + 1;
      }
      if (fault === 'omit-column') {
        out.push({ oid: varbind.oid, type: BER_TAG.NoSuchInstance });
        return;
      }
      if (!instance) {
        out.push({ oid: varbind.oid, type: BER_TAG.NoSuchObject });
        return;
      }
      out.push(this.varbindFor(instance));
    });
    return encodeResponse(message, out, errorStatus, errorIndex);
  }

  handleGetNext(message, controls, context) {
    const out = [];
    let errorStatus = 0;
    let errorIndex = 0;
    message.pdu.varbinds.forEach((varbind, index) => {
      const step = this.step(varbind.oid, controls, context, this.columnAt(varbind.oid));
      if (step.fatal) {
        errorStatus = errorStatus || step.fatal.errorStatus;
        errorIndex = errorIndex || index + 1;
        out.push({ oid: varbind.oid, type: BER_TAG.Null });
        return;
      }
      out.push(step.varbind);
    });
    return encodeResponse(message, out, errorStatus, errorIndex);
  }

  handleGetBulk(message, controls, context) {
    const pdu = message.pdu;
    const nonRepeaters = Math.max(0, Math.min(pdu.nonRepeaters || 0, pdu.varbinds.length));
    const repeats = Math.max(0, pdu.maxRepetitions || 0);
    const out = [];
    let errorStatus = 0;
    let errorIndex = 0;

    for (let i = 0; i < nonRepeaters; i++) {
      const step = this.step(pdu.varbinds[i].oid, controls, context, this.columnAt(pdu.varbinds[i].oid));
      if (step.fatal) {
        errorStatus = errorStatus || step.fatal.errorStatus;
        errorIndex = errorIndex || i + 1;
        out.push({ oid: pdu.varbinds[i].oid, type: BER_TAG.Null });
      } else {
        out.push(step.varbind);
      }
    }

    const repeaters = pdu.varbinds.slice(nonRepeaters);
    // Cursor the next instance is sought after. It only differs from the
    // client's cursor when a fault answered without advancing (e.g.
    // out-of-order); that way the walk can still cross the subtree and end.
    const seeks = repeaters.map((varbind) => varbind.oid.slice());
    let emptyBecauseFault = false;

    for (let round = 0; round < repeats && !errorStatus; round++) {
      for (let index = 0; index < repeaters.length; index++) {
        if (errorStatus) break;
        const location = this.columnAt(seeks[index]);
        const fault = this.faultFor(location ? location.column : null, controls);

        if (fault === 'no-advance') {
          // This agent answers with zero varbinds for the whole request.
          emptyBecauseFault = true;
          break;
        }

        const step = this.step(seeks[index], controls, context, location);
        if (step.fatal) {
          errorStatus = step.fatal.errorStatus;
          errorIndex = out.length + 1;
          out.push({ oid: seeks[index], type: BER_TAG.Null });
          break;
        }
        out.push(step.varbind);
        if (step.served) seeks[index] = step.varbind.oid.slice();
      }
      if (emptyBecauseFault) break;
    }

    if (emptyBecauseFault) {
      this.log({ kind: 'getbulk', client: null, note: 'fault mode no-advance returned no varbinds' });
      return encodeResponse(message, [], 0, 0);
    }

    return encodeResponse(message, out, errorStatus, errorIndex);
  }

  send(buffer, rinfo) {
    if (!this.socket) return;
    this.socket.send(buffer, rinfo.port, rinfo.address);
  }

  log(entry) {
    if (this.onRequest) this.onRequest({ at: new Date().toISOString(), ...entry });
  }
}

function pduTypeName(type) {
  for (const [name, value] of Object.entries(PDU_TYPE)) {
    if (value === type) return name;
  }
  return `pdu-${type}`;
}

/**
 * Encode a GET response. Varbinds are `{oid, type:'value', column, value}`,
 * `{oid, type: BER_TAG.EndOfMibView}` or `{oid, type: BER_TAG.NoSuchObject |
 * NoSuchInstance | Null}`. Returned together with metadata the request log
 * needs.
 */
export function encodeResponse(request, varbinds, errorStatus = 0, errorIndex = 0) {
  const writer = new Writer();
  writer.startSequence();
  writer.writeInt(request.version, BER_TAG.Integer);
  writer.writeString(request.community);
  writer.startSequence(PDU_TYPE.GetResponse);
  writer.writeInt(request.pdu.id, BER_TAG.Integer);
  writer.writeInt(errorStatus, BER_TAG.Integer);
  writer.writeInt(errorIndex, BER_TAG.Integer);
  writer.startSequence();
  for (const varbind of varbinds) {
    writer.startSequence();
    writer.writeOID(varbind.oid.join('.'));
    if (varbind.type === 'value') {
      writeColumnValue(writer, varbind.column, varbind.value);
    } else if (varbind.type === BER_TAG.EndOfMibView) {
      writeEndOfMibViewValue(writer);
    } else if (varbind.type === BER_TAG.Null) {
      writeNullValue(writer, BER_TAG.Null);
    } else {
      writer.writeByte(varbind.type);
      writer.writeLength(0);
    }
    writer.endSequence();
  }
  writer.endSequence();
  writer.endSequence();
  writer.endSequence();

  const buffer = writer.buffer;
  buffer.errorStatus = errorStatus;
  buffer.varbindCount = varbinds.length;
  return buffer;
}

/** Parse the subset of SNMPv2c messages this agent answers. */
export function decodeSnmpRequest(buffer) {
  const reader = new Reader(buffer);
  if (reader.readSequence() === null) throw new Error('Not a sequence');
  const version = reader.readInt();
  const community = reader.readString();
  const pduTag = reader.peek();
  reader.readSequence();
  const id = reader.readInt();
  const field2 = reader.readInt();
  const field3 = reader.readInt();
  reader.readSequence(); // varbind list

  const varbinds = [];
  while (reader.remain > 2) {
    const tag = reader.peek();
    if (tag === null || tag === 0) break;
    reader.readSequence();
    const oid = parseOid(reader.readOID());
    // Request values are always Null (tag 5, length 0); tolerate anything by
    // skipping the TLV body generically.
    reader.readByte();
    const length = reader.readLength();
    if (length === null) break;
    reader._offset = length;
    varbinds.push({ oid });
  }

  const isBulk = pduTag === PDU_TYPE.GetBulkRequest;
  return {
    version,
    community,
    pdu: {
      type: pduTag,
      id,
      nonRepeaters: isBulk ? field2 : 0,
      maxRepetitions: isBulk ? field3 : 0,
      varbinds,
    },
  };
}

export async function startDemoAgent(options) {
  const agent = new DemoAgent(options);
  await agent.start({ host: options.host, port: options.port });
  return agent;
}
