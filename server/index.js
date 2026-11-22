/**
 * HTTP API and static host for the SNMP table studio.
 *
 * Everything binds to loopback. The API accepts only OIDs that belong to a
 * table loaded from ./mibs, so the collector can never be pointed at an
 * arbitrary OID from the browser. Collect requests are sequential per table
 * selection and capped by the collector itself.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MibRegistry } from './mibRegistry.js';
import { DemoAgent } from './demoAgent.js';
import { collectTable } from './collector.js';
import { RunStore } from './runStore.js';
import { runToCsv, runToJson } from './exporters.js';
import { DEMO_HOLES, DEMO_ROWS, FAULT_MODES } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const HOST = '127.0.0.1';
const WEB_PORT = Number(process.env.PORT || 3000);
const DEMO_AGENT_PORT = Number(process.env.DEMO_AGENT_PORT || 16161);
const MIB_DIR = process.env.MIB_DIR || path.join(projectRoot, 'mibs');
const DB_FILE = process.env.DB_FILE || path.join(projectRoot, 'data', 'runs.sqlite3');

const MAX_COLUMNS = 32;
const MAX_BULK_SIZE = 50;
const MIN_BULK_SIZE = 1;
const REQUEST_SIZE_LIMIT = 64 * 1024;

export function createApp({ registry, store, demoAgent, agentTarget, controls }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));

  // Only loopback clients are served, even if the bind address is changed.
  app.use((req, res, next) => {
    const address = req.socket.remoteAddress || '';
    const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
    if (!loopback) {
      res.status(403).json({ error: 'Local access only' });
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      host: HOST,
      demoAgent: demoAgent ? { host: demoAgent.address, port: demoAgent.port, running: demoAgent.running } : null,
      agentTarget,
      mibDirectory: MIB_DIR,
    });
  });

  app.get('/api/mibs', (req, res) => {
    res.json({
      directory: MIB_DIR,
      files: registry.loadedFiles.map((entry) => entry.file),
      errors: registry.loadErrors,
      modules: registry.modules,
      tables: registry.listTables(),
    });
  });

  app.get('/api/mibs/tables/:name', (req, res) => {
    const table = registry.getTable(req.params.name);
    if (!table) {
      res.status(404).json({ error: `Unknown table: ${req.params.name}` });
      return;
    }
    res.json(table);
  });

  app.get('/api/demo/fixtures', (req, res) => {
    res.json({
      faultModes: FAULT_MODES,
      defaultHoles: DEMO_HOLES,
      // The matrix is what makes the "delete some values" control useful:
      // the UI can offer every existing row of every table as a hole target.
      rows: DEMO_ROWS,
      tables: registry.listTables().map((table) => ({
        module: table.module,
        name: table.name,
        indexParts: table.indexParts,
        columns: table.columns.filter((column) => column.readable).map((column) => column.name),
      })),
      demoAgent: demoAgent ? { host: demoAgent.address, port: demoAgent.port, running: demoAgent.running } : null,
    });
  });

  if (controls) {
    app.get('/api/demo/controls', (req, res) => {
      res.json({ controls: controls.snapshot(), demoAgent: demoAgent ? { host: demoAgent.address, port: demoAgent.port } : null });
    });

    app.put('/api/demo/controls', (req, res) => {
      try {
        const patch = validateControlsPatch(req.body, registry);
        controls.update(patch);
        res.json({ controls: controls.snapshot() });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    });

    app.post('/api/demo/reset', (req, res) => {
      controls.reset();
      res.json({ controls: controls.snapshot() });
    });
  }

  app.get('/api/runs', (req, res) => {
    res.json({ runs: store.listRuns(Number(req.query.limit) || 50) });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = store.getRun(validateId(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  });

  app.get('/api/runs/:id/export.csv', (req, res) => {
    const run = store.getRun(validateId(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const delimiter = req.query.delimiter === ';' ? ';' : ',';
    const csv = runToCsv(run, { delimiter });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="snmp-${run.table.name}-run-${run.id}.csv"`,
    );
    res.send(csv);
  });

  app.get('/api/runs/:id/export.json', (req, res) => {
    const run = store.getRun(validateId(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="snmp-${run.table.name}-run-${run.id}.json"`,
    );
    res.send(runToJson(run));
  });

  app.delete('/api/runs/:id', (req, res) => {
    const deleted = store.deleteRun(validateId(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.status(204).end();
  });

  app.post('/api/collect', async (req, res) => {
    let request;
    try {
      request = validateCollectRequest(req.body, registry, agentTarget);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    try {
      const result = await collectTable(request);
      const saved = store.save(result, request.agent);
      res.json(saved);
    } catch (error) {
      res.status(502).json({
        error: error.message,
        code: error.name || 'CollectError',
      });
    }
  });

  if (fs.existsSync(path.join(projectRoot, 'web', 'dist'))) {
    app.use(express.static(path.join(projectRoot, 'web', 'dist'), { index: 'index.html' }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.sendFile(path.join(projectRoot, 'web', 'dist', 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res
        .status(200)
        .type('text/plain')
        .send('The web UI has not been built yet. Run `npm run dev` or `npm run build`.');
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: error.message || 'Internal error' });
  });

  return app;
}

function validateId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Invalid run id');
    error.status = 400;
    throw error;
  }
  return id;
}

const FAULT_IDS = new Set(FAULT_MODES.map((mode) => mode.id));

/** Validate a demo-control patch against known tables, columns and modes. */
export function validateControlsPatch(body, registry) {
  if (!body || typeof body !== 'object') throw new Error('Request body must be JSON');
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.community !== undefined) {
    if (typeof body.community !== 'string' || !body.community.length) throw new Error('Community must be a non-empty string');
    patch.community = body.community.slice(0, 64);
  }
  if (body.faultMode !== undefined) {
    if (!FAULT_IDS.has(body.faultMode)) throw new Error(`Unknown fault mode: ${body.faultMode}`);
    patch.faultMode = body.faultMode;
  }
  if (body.columnFaults !== undefined) {
    if (!body.columnFaults || typeof body.columnFaults !== 'object') throw new Error('columnFaults must be an object');
    patch.columnFaults = {};
    for (const [column, mode] of Object.entries(body.columnFaults)) {
      if (mode === 'inherit') continue;
      if (!FAULT_IDS.has(mode)) throw new Error(`Unknown fault mode for ${column}: ${mode}`);
      const known = Array.from(registry.tables.values()).some((table) =>
        table.columns.some((item) => item.name === column),
      );
      if (!known) throw new Error(`Unknown column in columnFaults: ${column}`);
      patch.columnFaults[column] = mode;
    }
  }
  if (body.holes !== undefined) {
    if (!body.holes || typeof body.holes !== 'object') throw new Error('holes must be an object');
    patch.holes = {};
    for (const [tableName, columns] of Object.entries(body.holes)) {
      const table = registry.getTable(tableName);
      if (!table) throw new Error(`Unknown table in holes: ${tableName}`);
      patch.holes[tableName] = {};
      for (const [columnName, indexes] of Object.entries(columns || {})) {
        if (!table.columns.some((column) => column.name === columnName)) {
          throw new Error(`Unknown column in holes: ${tableName}.${columnName}`);
        }
        if (!Array.isArray(indexes)) throw new Error(`holes for ${columnName} must be an array`);
        patch.holes[tableName][columnName] = indexes.map((index) => {
          if (!Array.isArray(index) || index.length !== table.indexParts.length) {
            throw new Error(`Hole in ${tableName}.${columnName} must be an index array of length ${table.indexParts.length}`);
          }
          return index;
        });
      }
    }
  }
  return patch;
}

/**
 * Validate a collect request against the loaded MIB model.
 *
 * The client may only ask for columns of a known table, may not exceed the
 * column limit, and may not supply a host other than loopback. Bulk size is
 * bounded so a single request cannot ask the agent for an unbounded response.
 */
export function validateCollectRequest(body, registry, defaultTarget) {
  if (!body || typeof body !== 'object') throw new Error('Request body must be JSON');
  const tableName = typeof body.table === 'string' ? body.table : '';
  const table = registry.getTable(tableName);
  if (!table) throw new Error(`Unknown table: ${tableName || '(missing)'}`);

  const requested = Array.isArray(body.columns) ? body.columns : [];
  if (!requested.length) throw new Error('Select at least one column');
  if (requested.length > MAX_COLUMNS) throw new Error(`At most ${MAX_COLUMNS} columns per run`);
  const unique = Array.from(new Set(requested));
  for (const name of unique) {
    const column = table.columns.find((item) => item.name === name);
    if (!column) throw new Error(`Column ${name} does not belong to ${tableName}`);
    if (['not-accessible', 'accessible-for-notify'].includes(column.maxAccess)) {
      throw new Error(`Column ${name} is not readable (MAX-ACCESS ${column.maxAccess})`);
    }
  }

  const bulkSizeRaw = body.bulkSize ?? 10;
  const bulkSize = Number(bulkSizeRaw);
  if (!Number.isInteger(bulkSize) || bulkSize < MIN_BULK_SIZE || bulkSize > MAX_BULK_SIZE) {
    throw new Error(`bulkSize must be an integer between ${MIN_BULK_SIZE} and ${MAX_BULK_SIZE}`);
  }

  const agentInput = body.agent || {};
  const host = String(agentInput.host || defaultTarget.host);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Only loopback agents are allowed');
  }
  const port = Number(agentInput.port ?? defaultTarget.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid agent port');
  const timeoutMs = clamp(Number(agentInput.timeoutMs ?? 1500), 100, 10000);
  const retries = Math.trunc(clamp(Number(agentInput.retries ?? 0), 0, 3));
  const community = String(agentInput.community || 'public').slice(0, 64);

  return {
    table,
    columnNames: unique,
    bulkSize,
    agent: { host, port, community, timeoutMs, retries },
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Demo controls are process-wide: they describe how the local agent behaves
 * for the next request, not how a particular run starts.
 */
export function createDemoControls(initial = {}) {
  const controls = {
    enabled: true,
    community: 'public',
    faultMode: 'none',
    columnFaults: {},
    holes: JSON.parse(JSON.stringify(DEMO_HOLES)),
    ...initial,
  };
  return {
    snapshot: () => JSON.parse(JSON.stringify(controls)),
    reset() {
      controls.enabled = true;
      controls.community = 'public';
      controls.faultMode = 'none';
      controls.columnFaults = {};
      controls.holes = JSON.parse(JSON.stringify(DEMO_HOLES));
      return controls;
    },
    get: () => controls,
    update(patch) {
      if (patch && typeof patch === 'object') {
        if (patch.enabled !== undefined) controls.enabled = Boolean(patch.enabled);
        if (typeof patch.community === 'string') controls.community = patch.community.slice(0, 64) || 'public';
        if (typeof patch.faultMode === 'string') controls.faultMode = patch.faultMode;
        if (patch.columnFaults && typeof patch.columnFaults === 'object') {
          controls.columnFaults = {};
          for (const [column, mode] of Object.entries(patch.columnFaults)) {
            if (typeof mode === 'string' && mode !== 'inherit') controls.columnFaults[column] = mode;
          }
        }
        if (patch.holes && typeof patch.holes === 'object') {
          for (const [table, columns] of Object.entries(patch.holes)) {
            if (!controls.holes[table]) controls.holes[table] = {};
            if (!columns || typeof columns !== 'object') continue;
            for (const [column, indexes] of Object.entries(columns)) {
              if (!Array.isArray(indexes)) continue;
              controls.holes[table][column] = indexes;
            }
          }
        }
      }
      return controls;
    },
  };
}

async function main() {
  const registry = new MibRegistry(MIB_DIR).load();
  const store = new RunStore(DB_FILE);
  const controls = createDemoControls();
  const agentTarget = {
    host: HOST,
    port: DEMO_AGENT_PORT,
  };

  const tables = Array.from(registry.tables.values());
  const demoAgent = new DemoAgent({
    tables,
    getControls: controls.snapshot,
  });
  try {
    await demoAgent.start({ host: HOST, port: DEMO_AGENT_PORT });
  } catch (error) {
    console.error(`Unable to start demo agent on ${HOST}:${DEMO_AGENT_PORT}: ${error.message}`);
    console.error('Another local SNMP agent may already be listening on that port. Set DEMO_AGENT_PORT to change it.');
    process.exit(1);
  }

  const app = createApp({ registry, store, demoAgent, agentTarget, controls });

  const server = app.listen(WEB_PORT, HOST, () => {
    console.log(`SNMP table studio: http://${HOST}:${WEB_PORT}`);
    console.log(`Demo SNMP agent:   udp ${HOST}:${demoAgent.port} (community "public")`);
    console.log(`MIB directory:     ${MIB_DIR}`);
    console.log(`SQLite database:   ${DB_FILE}`);
  });

  const shutdown = () => {
    server.close();
    demoAgent.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
