/**
 * Builds a small, explicit table model from MIB modules parsed by the
 * net-snmp module store. The collector must know the exact index encoding
 * (fixed length, IMPLIED, IpAddress, enumeration labels) - information the
 * generic provider list in net-snmp flattens away - so the model is derived
 * here and shared with the browser over /api/mibs.
 */

const SYNTAX_KIND = {
  integer: 'integer',
  'integer32': 'integer',
  unsigned32: 'integer',
  gauge32: 'integer',
  gauge: 'integer',
  counter32: 'integer',
  counter: 'integer',
  counter64: 'integer',
  timeticks: 'integer',
  octetstring: 'octets',
  'octet string': 'octets',
  displaystring: 'octets',
  physaddress: 'octets',
  macaddress: 'octets',
  oid: 'oid',
  'object identifier': 'oid',
  ipaddress: 'ipaddress',
};

const COLUMN_BASE_TYPE = {
  integer: 'Integer32',
  octets: 'OCTET STRING',
  oid: 'OBJECT IDENTIFIER',
  ipaddress: 'IpAddress',
};

// net-snmp resolves textual conventions to numeric ASN.1 tags.
const OBJECT_TYPE_KIND = {
  1: { base: 'Boolean', kind: 'integer' },
  2: { base: 'Integer32', kind: 'integer' },
  3: { base: 'BITS', kind: 'octets' },
  4: { base: 'OCTET STRING', kind: 'octets' },
  5: { base: 'Null', kind: null },
  6: { base: 'OBJECT IDENTIFIER', kind: 'oid' },
  64: { base: 'IpAddress', kind: 'ipaddress' },
  65: { base: 'Counter32', kind: 'integer' },
  66: { base: 'Gauge32', kind: 'integer' },
  67: { base: 'TimeTicks', kind: 'integer' },
  68: { base: 'Opaque', kind: 'octets' },
  70: { base: 'Counter64', kind: 'integer' },
};

/** Normalise a MIB SYNTAX (string or constrained object) to a primitive. */
function syntaxInfo(syntax, syntaxTypes) {
  if (syntax === undefined || syntax === null) {
    return { base: 'unresolved', kind: null, constraints: null, enumeration: null, text: 'UNKNOWN' };
  }
  if (typeof syntax === 'string') {
    const text = syntax;
    const resolved = syntaxTypes ? syntaxTypes[syntax] : undefined;
    if (resolved !== undefined && resolved !== syntax) {
      if (typeof resolved === 'number') {
        const mapped = OBJECT_TYPE_KIND[resolved];
        if (mapped) {
          return {
            base: mapped.base,
            kind: mapped.kind,
            constraints: null,
            enumeration: null,
            text,
          };
        }
      }
      if (typeof resolved === 'object' && resolved !== null) {
        const objectKeys = Object.keys(resolved);
        if (objectKeys.length === 1) {
          const inner = resolved[objectKeys[0]];
          if (inner && typeof inner === 'object' && inner.ranges) {
            return {
              base: objectKeys[0],
              kind: SYNTAX_KIND[objectKeys[0].toLowerCase()] || null,
              constraints: { ranges: inner.ranges },
              enumeration: null,
              text,
            };
          }
          if (inner && typeof inner === 'object' && inner.sizes) {
            return {
              base: objectKeys[0],
              kind: SYNTAX_KIND[objectKeys[0].toLowerCase()] || null,
              constraints: { sizes: inner.sizes },
              enumeration: null,
              text,
            };
          }
          return {
            base: objectKeys[0],
            kind: SYNTAX_KIND[objectKeys[0].toLowerCase()] || null,
            constraints: null,
            enumeration: inner && typeof inner === 'object' ? normaliseEnum(inner) : null,
            text,
          };
        }
      }
      return syntaxInfo(resolved, null);
    }
    if (syntax.toUpperCase() === 'INTEGER' || syntax === 'Integer') {
      return { base: 'INTEGER', kind: 'integer', constraints: null, enumeration: null, text };
    }
    return {
      base: syntax,
      kind: SYNTAX_KIND[syntax.toLowerCase()] || null,
      constraints: null,
      enumeration: null,
      text,
    };
  }
  // Constrained form: { INTEGER: {...} } / { 'OCTET STRING': { sizes } }
  const keys = Object.keys(syntax);
  if (keys.length === 1) {
    const base = keys[0];
    const inner = syntax[base];
    let constraints = null;
    let enumeration = null;
    if (inner && typeof inner === 'object') {
      if (inner.ranges) constraints = { ranges: inner.ranges };
      if (inner.sizes) constraints = { sizes: inner.sizes };
      if (!inner.ranges && !inner.sizes) enumeration = normaliseEnum(inner);
    }
    return {
      base,
      kind: SYNTAX_KIND[base.toLowerCase()] || null,
      constraints,
      enumeration,
      text: base,
    };
  }
  return { base: 'unresolved', kind: null, constraints: null, enumeration: null, text: 'UNKNOWN' };
}

function normaliseEnum(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    out[String(key)] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

function numericColumnNumber(indexPath) {
  const parts = String(indexPath || '').trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const n = Number.parseInt(last, 10);
  return Number.isInteger(n) ? n : null;
}

/** Pull `(SIZE (a..b))` and `(a..b)` style bounds out of a column definition. */
export function sizeBounds(constraints) {
  let min = null;
  let max = null;
  if (constraints && Array.isArray(constraints.sizes)) {
    for (const range of constraints.sizes) {
      if (min === null || range.min < min) min = range.min;
      if (max === null || range.max > max) max = range.max;
    }
  }
  return { sizeMin: min, sizeMax: max };
}

export function rangeBounds(constraints) {
  if (!constraints || !Array.isArray(constraints.ranges) || !constraints.ranges.length) return null;
  return constraints.ranges.reduce(
    (acc, range) => ({
      min: Math.min(acc.min, range.min),
      max: Math.max(acc.max, range.max),
    }),
    { min: Infinity, max: -Infinity },
  );
}

/**
 * Turn a parsed module into the list of conversable tables.
 *
 * @param {object} moduleObj parsed module as returned by net-snmp's ModuleStore
 * @param {string} moduleName
 * @param {object} syntaxTypes resolved textual conventions for the store
 * @param {object} store module store (for cross-module lookups)
 */
export function buildTablesForModule(moduleObj, moduleName, syntaxTypes, store) {
  const entries = Object.values(moduleObj);
  const tables = [];
  const byOid = new Map();
  for (const entry of entries) {
    if (entry && entry.OID) byOid.set(entry.OID, entry);
  }

  const entryObjects = entries.filter(
    (entry) =>
      entry &&
      entry.MACRO === 'OBJECT-TYPE' &&
      (Array.isArray(entry.INDEX) || Array.isArray(entry.AUGMENTS)) &&
      entry.OID,
  );

  for (const entryObj of entryObjects) {
    // The parent table object (SEQUENCE OF ...) is one OID component up.
    const parentOid = entryObj.OID.split('.').slice(0, -1).join('.');
    const parent = byOid.get(parentOid);
    const tableOid = parent ? parent.OID : parentOid;
    const tableName = parent ? parent.ObjectName : entryObj.ObjectName.replace(/Entry$/, 'Table');

    let indexEntries;
    let augments = null;
    if (Array.isArray(entryObj.AUGMENTS) && entryObj.AUGMENTS.length) {
      augments = entryObj.AUGMENTS[0].trim();
      const baseEntry = entries.find((entry) => entry.ObjectName === augments);
      if (baseEntry && Array.isArray(baseEntry.INDEX)) indexEntries = baseEntry.INDEX.slice();
      else indexEntries = [];
    } else {
      indexEntries = entryObj.INDEX.slice();
    }

    const columns = entries
      .filter(
        (column) =>
          column &&
          column.MACRO === 'OBJECT-TYPE' &&
          column.OID &&
          column.OID.startsWith(entryObj.OID + '.'),
      )
      .map((column) => {
        const info = syntaxInfo(column.SYNTAX, syntaxTypes);
        const bounds = sizeBounds(info.constraints);
        const ranges = rangeBounds(info.constraints);
        return {
          number: numericColumnNumber(column['OBJECT IDENTIFIER']),
          name: column.ObjectName,
          oid: column.OID,
          maxAccess: column['MAX-ACCESS'] || column.ACCESS || 'not-accessible',
          readable: !['not-accessible', 'accessible-for-notify'].includes(
            column['MAX-ACCESS'] || column.ACCESS || 'not-accessible',
          ),
          syntaxText: describeSyntax(column.SYNTAX, info),
          baseType: info.base,
          kind: info.kind,
          constraints: info.constraints,
          enumeration: info.enumeration,
          ranges,
          sizeMin: bounds.sizeMin,
          sizeMax: bounds.sizeMax,
          description: firstLine(column.DESCRIPTION),
          defVal: column.DEFVAL,
        };
      })
      .filter((column) => Number.isInteger(column.number))
      .sort((a, b) => a.number - b.number);

    const columnByName = new Map(columns.map((column) => [column.name, column]));
    const indexParts = [];
    for (const raw of indexEntries) {
      indexParts.push(describeIndexPart(raw, columnByName, syntaxTypes, entries));
    }

    // An AUGMENTS table has an EMPTY index of its own in the sense that its
    // column OIDs still carry the base table's index suffix.
    tables.push({
      module: moduleName,
      name: tableName,
      entryName: entryObj.ObjectName,
      oid: entryObj.OID,
      tableOid,
      baseOid: entryObj.OID,
      description: firstLine(parent ? parent.DESCRIPTION : entryObj.DESCRIPTION),
      indexParts,
      augments,
      columns,
    });
  }

  // Resolve foreign index columns (e.g. INDEX { ifIndex } where ifIndex is
  // declared in another table of the same or another loaded module).
  const allColumns = new Map();
  for (const table of tables) {
    for (const column of table.columns) {
      if (!allColumns.has(column.name)) allColumns.set(column.name, { column, table });
    }
  }
  for (const table of tables) {
    for (const part of table.indexParts) {
      if (part.resolved || !part.columnName) continue;
      const found = allColumns.get(part.columnName);
      if (found) {
        Object.assign(part, deriveIndexShape(found.column, syntaxTypes));
        part.resolved = true;
        part.sourceTable = found.table.name;
      }
    }
  }

  return tables.filter((table) => table.columns.length > 0);
}

/**
 * Build an index descriptor from its INDEX clause token, e.g.
 * "ifIndex", "IMPLIED ifName", or "ifRcvAddressAddress".
 */
function describeIndexPart(raw, columnByName, syntaxTypes, allEntries) {
  let token = String(raw).trim().replace(/\s+/g, ' ');
  let implied = false;
  if (/^IMPLIED\s+/i.test(token)) {
    implied = true;
    token = token.replace(/^IMPLIED\s+/i, '');
  }
  // Some MIBs qualify the name ("MODULE::name") or carry an object number.
  const bare = token.split(/\s+/).pop();
  const explicitNumber = Number.parseInt(token.split(/\s+/)[1], 10);
  const column = columnByName.get(bare);
  const fallbackEntry = allEntries.find((entry) => entry.ObjectName === bare);
  if (column) {
    return { ...deriveIndexShape(column, syntaxTypes), implied, columnName: bare, resolved: true };
  }
  if (fallbackEntry) {
    const pseudo = {
      name: bare,
      number: Number.isInteger(explicitNumber) ? explicitNumber : null,
      kind: syntaxInfo(fallbackEntry.SYNTAX, syntaxTypes).kind,
      baseType: syntaxInfo(fallbackEntry.SYNTAX, syntaxTypes).base,
      sizeMin: sizeBounds(syntaxInfo(fallbackEntry.SYNTAX, syntaxTypes).constraints).sizeMin,
      sizeMax: sizeBounds(syntaxInfo(fallbackEntry.SYNTAX, syntaxTypes).constraints).sizeMax,
      enumeration: syntaxInfo(fallbackEntry.SYNTAX, syntaxTypes).enumeration,
    };
    return { ...deriveIndexShape(pseudo, syntaxTypes), implied, columnName: bare, resolved: true };
  }
  return {
    name: bare,
    columnName: bare,
    kind: 'octets',
    implied,
    fixedLength: null,
    sizeMin: null,
    sizeMax: null,
    enumeration: null,
    resolved: false,
  };
}

/** Derive the index encoding shape of a column. */
export function deriveIndexShape(column, syntaxTypes) {
  const info =
    column.kind !== undefined
      ? {
          base: column.baseType,
          kind: column.kind,
          constraints:
            column.constraints ||
            (column.sizeMin !== undefined && column.sizeMin !== null
              ? { sizes: [{ min: column.sizeMin, max: column.sizeMax }] }
              : null),
        }
      : syntaxInfo(column.syntaxText, syntaxTypes);
  const kind = info.kind || 'octets';
  const bounds = sizeBounds(info.constraints);
  const fixed = kind === 'octets' && bounds.sizeMin !== null && bounds.sizeMin === bounds.sizeMax
    ? bounds.sizeMin
    : null;
  return {
    name: column.name,
    kind,
    baseType: info.base || COLUMN_BASE_TYPE[kind],
    implied: false,
    fixedLength: kind === 'octets' ? fixed : null,
    sizeMin: bounds.sizeMin,
    sizeMax: bounds.sizeMax,
    enumeration: info.enumeration || column.enumeration || null,
    description: column.description || '',
  };
}

function describeSyntax(rawSyntax, info) {
  if (typeof rawSyntax === 'string') return rawSyntax;
  if (rawSyntax && typeof rawSyntax === 'object') {
    const base = Object.keys(rawSyntax)[0];
    if (!base) return info.base;
    const inner = rawSyntax[base];
    if (inner && inner.ranges) {
      const text = inner.ranges
        .map((range) => (range.min === range.max ? `${range.min}` : `${range.min}..${range.max}`))
        .join(' | ');
      return `${base} (${text})`;
    }
    if (inner && inner.sizes) {
      const text = inner.sizes
        .map((range) => (range.min === range.max ? `${range.min}` : `${range.min}..${range.max}`))
        .join(' | ');
      return `${base} (SIZE (${text}))`;
    }
    const values = Object.entries(inner || {})
      .map(([number, label]) => `${label}(${number})`)
      .join(', ');
    return `${base} { ${values} }`;
  }
  return info.base;
}

function firstLine(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim();
}
