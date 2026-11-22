import test from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape, toCsv } from '../shared/csv.js';

test('plain values are not quoted', () => {
  assert.equal(csvEscape('edge-01', ','), 'edge-01');
  assert.equal(csvEscape(42, ','), '42');
  assert.equal(csvEscape('', ','), '');
});

test('delimiters, quotes and newlines force RFC 4180 quoting', () => {
  assert.equal(csvEscape('a,b', ','), '"a,b"');
  assert.equal(csvEscape('say "hi"', ','), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2', ','), '"line1\nline2"');
  assert.equal(csvEscape('a;b', ','), 'a;b');
  assert.equal(csvEscape('a;b', ';'), '"a;b"');
});

test('formulas are neutralised so a spreadsheet cannot execute them', () => {
  assert.equal(csvEscape('=SUM(A1)', ','), "'=SUM(A1)");
  assert.equal(csvEscape('+1', ','), "'+1");
  assert.equal(csvEscape('-2', ','), "'-2");
  assert.equal(csvEscape('@cmd', ','), "'@cmd");
  // Once prefixed it still has to be quoted if it also contains a delimiter.
  assert.equal(csvEscape('=A1,B1', ','), '"\'=A1,B1"');
});

test('toCsv writes a CRLF-terminated document with a header row', () => {
  const csv = toCsv(['oid', 'value'], [['1.3.6', 'edge-01'], ['1.3.7', 'a,b']]);
  assert.equal(csv, 'oid,value\r\n1.3.6,edge-01\r\n1.3.7,"a,b"\r\n');
});

test('toCsv honours an alternative delimiter', () => {
  const csv = toCsv(['a', 'b'], [['x;y', 'z']], { delimiter: ';' });
  assert.equal(csv, 'a;b\r\n"x;y";z\r\n');
});
