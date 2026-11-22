/**
 * CSV/JSON export for a stored run.
 *
 * Each cell becomes three columns so that a missing value is distinguishable
 * from an empty string: `<column>.value`, `<column>.status` and
 * `<column>.oid`. Status is one of present, missing (column walk ended
 * normally without this instance), not-read (column walk stopped before
 * reaching this instance) or index-error rows.
 */

import { toCsv } from '../shared/csv.js';

export const CELL_STATUS_LABELS = {
  present: 'present',
  missing: 'missing',
  'not-read': 'not-read',
};

function cellValue(cell) {
  if (!cell) return { value: '', status: 'not-read', oid: '' };
  if (cell.status !== 'present') {
    return { value: '', status: CELL_STATUS_LABELS[cell.status] || cell.status, oid: cell.oid };
  }
  return {
    value: cell.valueText ?? cell.display ?? '',
    status: 'present',
    oid: cell.oid,
  };
}

/**
 * @param {object} run stored run as returned by RunStore.getRun
 * @param {{delimiter?: string}} [options]
 */
export function runToCsv(run, options = {}) {
  const headers = ['row', 'index_oid', 'index_display', 'index_status', 'row_status'];
  for (const column of run.columns) {
    headers.push(`${column.name}.value`, `${column.name}.status`, `${column.name}.oid`);
  }
  // Index values as one column per index part keep the CSV useful when the
  // index contains non-printable octets.
  const indexNames = (run.indexParts || []).map((part, i) => part.name || `index${i + 1}`);
  for (const name of indexNames) headers.push(`index.${name}`);

  const rows = run.rows.map((row) => {
    const cells = [
      row.ordinal,
      row.indexOid,
      row.indexDisplay,
      row.indexError ? `error: ${row.indexError}` : 'ok',
      row.status,
    ];
    for (const column of run.columns) {
      const cell = cellValue(row.cells[column.name]);
      cells.push(cell.value, cell.status, cell.oid);
    }
    for (let i = 0; i < indexNames.length; i++) {
      const indexValue = row.indexValues && row.indexValues[i];
      cells.push(indexValue ? indexValue.display ?? String(indexValue.value ?? '') : '');
    }
    return cells;
  });

  return toCsv(headers, rows, options);
}

export function runToJson(run) {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      run: {
        id: run.id,
        createdAt: run.createdAt,
        table: run.table,
        agent: run.agent,
        bulkSize: run.bulkSize,
        status: run.status,
        summary: run.summary,
        diagnostics: run.diagnostics,
      },
      indexParts: run.indexParts,
      columns: run.columns,
      walks: run.walks || [],
      rows: run.rows.map((row) => ({
        ordinal: row.ordinal,
        rowKey: row.rowKey,
        indexOid: row.indexOid,
        indexDisplay: row.indexDisplay,
        indexValues: row.indexValues,
        indexError: row.indexError,
        status: row.status,
        warnings: row.warnings,
        cells: Object.fromEntries(
          run.columns.map((column) => {
            const cell = row.cells[column.name];
            return [
              column.name,
              {
                oid: cell?.oid ?? '',
                status: cell?.status ?? 'not-read',
                type: cell?.type ?? column.baseType,
                value: cell?.status === 'present' ? (cell.valueText ?? cell.display) : null,
                display: cell?.status === 'present' ? cell.display : null,
                enumLabel: cell?.enumLabel ?? null,
                rawHex: cell?.rawHex ?? null,
              },
            ];
          }),
        ),
      })),
    },
    null,
    2,
  );
}
