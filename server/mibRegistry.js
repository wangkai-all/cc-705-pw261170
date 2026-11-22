/**
 * Loads MIB files from ./mibs with net-snmp's module store and exposes the
 * table model to the rest of the application. Files are parsed in filename
 * order with retries so that imported modules are registered before the
 * modules that import them, regardless of lexical order.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { buildTablesForModule } from './mibModel.js';

const require = createRequire(import.meta.url);
const snmp = require('net-snmp');

const BASE_MODULES = new Set([
  'SNMPv2-SMI',
  'SNMPv2-TC',
  'SNMPv2-CONF',
  'SNMPv2-MIB',
  'RFC1155-SMI',
  'RFC1158-MIB',
  'RFC-1212',
  'RFC1213-MIB',
  'RFC-1215',
]);

export class MibRegistry {
  constructor(directory) {
    this.directory = directory;
    this.store = snmp.createModuleStore();
    this.loadedFiles = [];
    this.failedFiles = [];
    this.modules = [];
    this.tables = new Map();
    this.loadErrors = [];
  }

  load() {
    this.loadedFiles = [];
    this.failedFiles = [];
    let files = [];
    try {
      files = fs
        .readdirSync(this.directory)
        .filter((name) => /\.(mib|txt|my)$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      this.loadErrors = [{ file: this.directory, error: error.message }];
      return this;
    }

    let pending = files.slice();
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      const next = [];
      for (const file of pending) {
        const fullPath = path.join(this.directory, file);
        const before = new Set(Object.keys(this.store.parser.Modules));
        try {
          this.store.loadFromFile(fullPath);
          const after = Object.keys(this.store.parser.Modules).filter((name) => !before.has(name));
          this.loadedFiles.push({ file, modules: after });
          progress = true;
        } catch (error) {
          next.push(file);
          this.failedFiles = next.slice();
          this.loadErrors.push({ file, error: error.message });
        }
      }
      if (!progress && next.length) break;
      pending = next.filter((file) => !this.loadedFiles.some((loaded) => loaded.file === file));
      this.failedFiles = pending.slice();
    }

    const syntaxTypes = this.store.getSyntaxTypes();
    const moduleNames = Object.keys(this.store.parser.Modules).filter((name) => !BASE_MODULES.has(name));
    this.modules = [];
    this.tables = new Map();
    for (const moduleName of moduleNames) {
      let tables = [];
      try {
        tables = buildTablesForModule(this.store.getModule(moduleName), moduleName, syntaxTypes, this.store);
      } catch (error) {
        this.loadErrors.push({ file: moduleName, error: error.message });
      }
      this.modules.push({
        name: moduleName,
        tableCount: tables.length,
        loadedFrom: this.loadedFiles.filter((entry) => entry.modules.includes(moduleName)).map((entry) => entry.file),
      });
      for (const table of tables) {
        this.tables.set(table.name, table);
      }
    }
    this.modules.sort((a, b) => a.name.localeCompare(b.name));
    return this;
  }

  getTable(name) {
    return this.tables.get(name) || null;
  }

  listTables() {
    return Array.from(this.tables.values())
      .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name))
      .map((table) => ({
        module: table.module,
        name: table.name,
        entryName: table.entryName,
        oid: table.oid,
        description: table.description,
        augments: table.augments,
        indexParts: table.indexParts,
        columns: table.columns.map((column) => ({
          name: column.name,
          number: column.number,
          oid: column.oid,
          baseType: column.baseType,
          kind: column.kind,
          syntaxText: column.syntaxText,
          enumeration: column.enumeration,
          sizeMin: column.sizeMin,
          sizeMax: column.sizeMax,
          maxAccess: column.maxAccess,
          readable: !['not-accessible', 'accessible-for-notify'].includes(column.maxAccess),
          isIndex: table.indexParts.some((part) => part.columnName === column.name),
          description: column.description,
        })),
      }));
  }
}
