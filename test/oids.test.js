import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOids, isPrefix, isStrictPrefix, parseOid, subOid } from '../shared/oids.js';

test('OID components compare numerically, not as strings', () => {
  assert.ok(compareOids([1, 3, 6, 1, 9], [1, 3, 6, 1, 10]) < 0, '9 sorts before 10');
  assert.ok(compareOids([1, 3, 6, 1, 10], [1, 3, 6, 1, 9]) > 0);
  assert.equal(compareOids([1, 3, 6], [1, 3, 6]), 0);
});

test('a prefix sorts before its extensions', () => {
  assert.ok(compareOids([1, 3, 6, 1], [1, 3, 6, 1, 0]) < 0);
  assert.ok(compareOids([1, 3, 6, 1, 0], [1, 3, 6, 1]) > 0);
});

test('parseOid accepts dotted strings and arrays', () => {
  assert.deepEqual(parseOid('1.3.6.1.4.1.32473'), [1, 3, 6, 1, 4, 1, 32473]);
  assert.deepEqual(parseOid([1, 3, 6]), [1, 3, 6]);
  assert.deepEqual(parseOid('1.3.6'), [1, 3, 6]);
  assert.throws(() => parseOid('1.3.x'), /Invalid OID component/);
});

test('isPrefix distinguishes a real prefix from a partial component match', () => {
  assert.equal(isPrefix([1, 3, 6], [1, 3, 6, 1]), true);
  assert.equal(isPrefix([1, 3, 6], [1, 3, 6]), true, 'a prefix of itself counts');
  assert.equal(isStrictPrefix([1, 3, 6], [1, 3, 6]), false);
  assert.equal(isPrefix([1, 3, 61], [1, 3, 6, 1]), false, '61 must not match 6.1');
});

test('subOid strips the base and returns null when it is not a prefix', () => {
  assert.deepEqual(subOid([1, 3, 6], [1, 3, 6, 1, 5]), [1, 5]);
  assert.equal(subOid([1, 3, 7], [1, 3, 6, 1]), null);
});
