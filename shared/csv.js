/**
 * RFC 4180 CSV writer with a guard against spreadsheet formula injection.
 *
 * The report deliberately contains raw OIDs, UTF-8 labels and missing-value
 * markers, so quoting has to be exact: values are quoted when they contain a
 * delimiter, quote or newline, embedded quotes are doubled, and a value that
 * starts with = + - @ (or a tab/CR) is prefixed with a single quote because
 * spreadsheet programs would otherwise evaluate an OctetString as a formula.
 */

function sanitiseFormula(value) {
  if (/^[=+\-@\t\r]/.test(value)) return "'" + value;
  return value;
}

export function csvEscape(value, delimiter) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = sanitiseFormula(text);
  const needsQuotes =
    safe.includes(delimiter) || safe.includes('"') || safe.includes('\n') || safe.includes('\r');
  if (!needsQuotes) return safe;
  return '"' + safe.replace(/"/g, '""') + '"';
}

/**
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 * @param {{delimiter?: string, newline?: string}} [options]
 */
export function toCsv(headers, rows, options = {}) {
  const delimiter = options.delimiter || ',';
  const newline = options.newline || '\r\n';
  const lines = [];
  lines.push(headers.map((header) => csvEscape(header, delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(row.map((cell) => csvEscape(cell, delimiter)).join(delimiter));
  }
  return lines.join(newline) + newline;
}

export const MISSING = {
  ABSENT: 'absent',
  ERROR: 'error',
  UNPARSED: 'unparsed-index',
};
