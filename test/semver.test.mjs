import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, parse, satisfies, parseRange } from '../dist/semver.js';

const order = (flavor, ...versions) => {
  for (let i = 1; i < versions.length; i++) {
    const a = parse(versions[i - 1], flavor);
    const b = parse(versions[i], flavor);
    assert.ok(a && b, `parse ${versions[i - 1]} / ${versions[i]}`);
    assert.equal(compare(a, b), -1, `${versions[i - 1]} < ${versions[i]}`);
  }
};
const yes = (flavor, v, r) => assert.ok(satisfies(parse(v, flavor), parseRange(r, flavor)), `${v} satisfies ${r}`);
const no = (flavor, v, r) => assert.ok(!satisfies(parse(v, flavor), parseRange(r, flavor)), `${v} does not satisfy ${r}`);

test('npm ordering (node-semver)', () => {
  order('npm', '0.0.1', '0.1.0', '1.0.0-0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0');
  assert.equal(compare(parse('v1.2.3'), parse('1.2.3+build.5')), 0);
  assert.equal(parse('1.2'), null, 'npm versions are always major.minor.patch');
});

test('PEP 440 ordering (packaging)', () => {
  order('pep440', '1.0.dev456', '1.0a1', '1.0a2.dev456', '1.0a2', '1.0a12', '1.0b1.dev456', '1.0b2', '1.0b2.post345', '1.0rc1', '1.0', '1.0.post456.dev34', '1.0.post456', '1.1.dev1', '2!0.1');
  assert.equal(compare(parse('1.0c1', 'pep440'), parse('1.0rc1', 'pep440')), 0, 'c == rc');
  assert.equal(compare(parse('2.0', 'pep440'), parse('2.0.0', 'pep440')), 0, 'zero padding');
  assert.equal(compare(parse('1.0-1', 'pep440'), parse('1.0.post1', 'pep440')), 0, 'implicit post');
});

test('npm caret and tilde', () => {
  yes('npm', '1.9.9', '^1.2.3'); no('npm', '2.0.0', '^1.2.3'); no('npm', '2.0.0-rc.1', '^1.2.3');
  yes('npm', '0.2.9', '^0.2.3'); no('npm', '0.3.0', '^0.2.3');
  yes('npm', '0.0.3', '^0.0.3'); no('npm', '0.0.4', '^0.0.3');
  yes('npm', '0.0.9', '^0.0'); no('npm', '0.1.0', '^0.0');
  yes('npm', '0.9.0', '^0'); no('npm', '1.0.0', '^0');
  yes('npm', '1.2.9', '~1.2.3'); no('npm', '1.3.0', '~1.2.3');
  yes('npm', '1.9.0', '~1'); no('npm', '2.0.0', '~1');
});

test('npm partials, wildcards and comparators', () => {
  yes('npm', '2.5.0', '<=2.x'); no('npm', '3.0.0', '<=2.x');
  yes('npm', '1.4.9', '<=1.4'); no('npm', '1.5.0', '<=1.4');
  no('npm', '1.3.5', '>1.3'); yes('npm', '1.4.0', '>1.3');
  no('npm', '1.5.0', '>1'); yes('npm', '2.0.0', '>1');
  no('npm', '5.0.0', '1.x.x'); yes('npm', '1.9.9', '1.x.x');
  yes('npm', '3.9.0', '3'); yes('npm', '3.9.0', '3.x'); yes('npm', '3.9.0', '3.*');
  yes('npm', '17.0.2', '>=16 <18'); yes('npm', '2.5.0', '1.x || 2.x'); yes('npm', '9.9.9', '*');
  yes('npm', '1.2.3', '=1.2.3'); no('npm', '1.2.4', '1.2.3');
});

test('npm hyphen ranges', () => {
  yes('npm', '1.5.0', '1.0.0 - 2.0.0'); no('npm', '2.0.1', '1.0.0 - 2.0.0');
  yes('npm', '2.3.5', '1.2.3 - 2.3'); no('npm', '2.4.0', '1.2.3 - 2.3');
  yes('npm', '2.9.0', '1.2.3 - 2'); no('npm', '3.0.0', '1.2.3 - 2');
});

test('npm prereleases only match ranges naming the same tuple', () => {
  no('npm', '4.0.0-beta.1', '>=3');
  yes('npm', '4.0.0-beta.2', '>=4.0.0-beta.1');
  no('npm', '4.0.1-beta.2', '>=4.0.0-beta.1');
  no('npm', '2.0.0-rc.1', '<2.0.0');
});

test('PEP 440 specifiers', () => {
  yes('pep440', '1.10.27', '<2'); no('pep440', '2.0.0', '<2');
  no('pep440', '2.0rc1', '<2'), 'exclusive < excludes prereleases of the bound';
  yes('pep440', '2.5.1', '>=2,<3');
  yes('pep440', '1.4.9', '~=1.4.5'); no('pep440', '1.5.0', '~=1.4.5');
  yes('pep440', '2.9', '~=2.2'); no('pep440', '3.0', '~=2.2');
  yes('pep440', '5.3', '==5.3'); yes('pep440', '5.3.0', '==5.3'); no('pep440', '5.3.1', '==5.3');
  yes('pep440', '5.3.1', '==5.3.*'); no('pep440', '5.4.0', '==5.3.*');
  no('pep440', '1.2.3', '!=1.2.*'); yes('pep440', '1.3.0', '!=1.2.*');
  no('pep440', '2.0.post1', '>2.0'); yes('pep440', '2.0.1', '>2.0');
  yes('pep440', '1.0', '===1.0'); no('pep440', '1.0.0', '===1.0');
  no('pep440', '2.0b1', '>=1'); yes('pep440', '2.0b1', '>=2.0b1');
});
