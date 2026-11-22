/**
 * SQLite persistence for collection runs.
 *
 * A run is stored relationally: one row per run, one row per table row
 * (row key decoded from the instance suffix), and one row per cell. Keeping
 * cells as rows rather than a JSON blob is what makes it possible to export
 * the exact missing/not-read status later without rerunning the walk.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  table_module  TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  table_oid     TEXT NOT NULL,
  agent_host    TEXT NOT NULL,
  agent_port    INTEGER NOT NULL,
  bulk_size     INTEGER NOT NULL,
  status        TEXT NOT NULL,
  row_count     INTEGER NOT NULL,
  summary_json  TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  columns_json  TEXT NOT NULL,
  index_parts_json TEXT NOT NULL,
  walks_json    TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS run_rows (
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  row_key       TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  index_oid     TEXT NOT NULL,
  index_display TEXT NOT NULL,
  index_json    TEXT NOT NULL,
  index_error   TEXT,
  status        TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  PRIMARY KEY (run_id, row_key)
);

CREATE TABLE IF NOT EXISTS run_cells (
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  row_key       TEXT NOT NULL,
  column_name   TEXT NOT NULL,
  oid           TEXT NOT NULL,
  status        TEXT NOT NULL,
  type_name     TEXT,
  value_text    TEXT,
  display       TEXT,
  enum_label    TEXT,
  raw_hex       TEXT,
  PRIMARY KEY (run_id, row_key, column_name)
);

CREATE INDEX IF NOT EXISTS run_cells_column ON run_cells (run_id, column_name, status);
`;

export class RunStore {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    // Databases created by an earlier version lack walks_json; add it rather
    // than refuse to start.
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
    if (!runColumns.includes('walks_json')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN walks_json TEXT NOT NULL DEFAULT '[]'");
    }

    this.insertRun = this.db.prepare(`
      INSERT INTO runs (created_at, table_module, table_name, table_oid, agent_host, agent_port,
                        bulk_size, status, row_count, summary_json, diagnostics_json,
                        columns_json, index_parts_json, walks_json)
      VALUES (@created_at, @table_module, @table_name, @table_oid, @agent_host, @agent_port,
              @bulk_size, @status, @row_count, @summary_json, @diagnostics_json,
              @columns_json, @index_parts_json, @walks_json)
    `);
    this.insertRow = this.db.prepare(`
      INSERT INTO run_rows (run_id, row_key, ordinal, index_oid, index_display, index_json,
                            index_error, status, warnings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertCell = this.db.prepare(`
      INSERT INTO run_cells (run_id, row_key, column_name, oid, status, type_name, value_text,
                             display, enum_label, raw_hex)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  close() {
    this.db.close();
  }

  /** Persist a collector result; returns the run id. */
  save(result, agent) {
    const saveAll = this.db.transaction((data) => {
      const info = this.insertRun.run({
        created_at: new Date().toISOString(),
        table_module: data.table.module,
        table_name: data.table.name,
        table_oid: data.table.oid,
        agent_host: agent.host,
        agent_port: agent.port,
        bulk_size: data.diagnostics.bulkSize,
        status: data.summary.status,
        row_count: data.summary.rowCount,
        summary_json: JSON.stringify(data.summary),
        diagnostics_json: JSON.stringify(data.diagnostics),
        columns_json: JSON.stringify(data.columns),
        index_parts_json: JSON.stringify(data.indexParts),
        walks_json: JSON.stringify(data.walks || []),
      });
      const runId = Number(info.lastInsertRowid);
      for (const row of data.rows) {
        this.insertRow.run(
          runId,
          row.rowKey,
          row.ordinal,
          row.indexOid,
          row.indexDisplay,
          JSON.stringify(row.indexValues),
          row.indexError || null,
          row.status,
          JSON.stringify(row.warnings || []),
        );
        for (const column of data.columns) {
          const cell = row.cells[column.name];
          if (!cell) continue;
          this.insertCell.run(
            runId,
            row.rowKey,
            column.name,
            cell.oid,
            cell.status,
            cell.type || null,
            cell.valueText ?? null,
            cell.display ?? null,
            cell.enumLabel ?? null,
            cell.rawHex ?? null,
          );
        }
      }
      return runId;
    });
    const runId = saveAll(result);
    return { runId, ...this.getRun(runId) };
  }

  listRuns(limit = 50) {
    return this.db
      .prepare(
        `SELECT id, created_at, table_module, table_name, table_oid, agent_host, agent_port,
                bulk_size, status, row_count
           FROM runs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        tableModule: row.table_module,
        tableName: row.table_name,
        tableOid: row.table_oid,
        agentHost: row.agent_host,
        agentPort: row.agent_port,
        bulkSize: row.bulk_size,
        status: row.status,
        rowCount: row.row_count,
      }));
  }

  getRun(id) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!run) return null;
    const rows = this.db
      .prepare('SELECT * FROM run_rows WHERE run_id = ? ORDER BY ordinal')
      .all(id);
    const cells = this.db.prepare('SELECT * FROM run_cells WHERE run_id = ?').all(id);
    const columns = JSON.parse(run.columns_json);
    const indexParts = JSON.parse(run.index_parts_json);

    const cellMap = new Map();
    for (const cell of cells) {
      const key = `${cell.row_key}\u0000${cell.column_name}`;
      cellMap.set(key, cell);
    }

    const assembledRows = rows.map((row) => ({
      rowKey: row.row_key,
      ordinal: row.ordinal,
      indexOid: row.index_oid,
      indexDisplay: row.index_display,
      indexValues: JSON.parse(row.index_json),
      indexError: row.index_error,
      status: row.status,
      warnings: JSON.parse(row.warnings_json),
      cells: Object.fromEntries(
        columns.map((column) => {
          const cell = cellMap.get(`${row.row_key}\u0000${column.name}`);
          return [
            column.name,
            cell
              ? {
                  oid: cell.oid,
                  status: cell.status,
                  type: cell.type_name,
                  valueText: cell.value_text,
                  display: cell.display,
                  enumLabel: cell.enum_label,
                  rawHex: cell.raw_hex,
                }
              : {
                  oid: `${column.oid}.${row.row_key}`,
                  status: 'not-read',
                  type: column.baseType,
                  valueText: '',
                  display: '',
                  enumLabel: null,
                  rawHex: null,
                },
          ];
        }),
      ),
    }));

    return {
      id: run.id,
      createdAt: run.created_at,
      table: {
        module: run.table_module,
        name: run.table_name,
        oid: run.table_oid,
      },
      columns,
      indexParts,
      rows: assembledRows,
      summary: JSON.parse(run.summary_json),
      diagnostics: JSON.parse(run.diagnostics_json),
      agent: { host: run.agent_host, port: run.agent_port },
      bulkSize: run.bulk_size,
      status: run.status,
      rowCount: run.row_count,
      walks: JSON.parse(run.walks_json || '[]'),
    };
  }

  deleteRun(id) {
    return this.db.prepare('DELETE FROM runs WHERE id = ?').run(id).changes > 0;
  }
}
