// node --test tests/   (Node 18+; no dependencies)
// Checks the seeded, replayable casts in oracle.html and index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('..', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, `markers ${a}..${b}`); return src.slice(i, j); };

function sandbox(confirmAnswer = false) {
  const store = {};
  const ctx = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    confirm: () => confirmAnswer, crypto: webcrypto, Intl, Date, Math, JSON, String, Object, Array, Uint32Array, console,
  };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}

const oracleSrc = between(read('oracle.html'), 'function hashStr(str)', 'function getQuestion(which)');
const indexSrc = between(read('index.html'), "const DICE_CAST_KEY", 'let lastDiceCast');

test('every inline script still parses', () => {
  for (const f of ['oracle.html', 'index.html']) {
    const blocks = [...read(f).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length > 0);
    blocks.forEach(b => new vm.Script(b, { filename: f }));
  }
});

test('ET stamp carries the New York offset across DST', () => {
  const c = sandbox(); vm.runInContext(oracleSrc, c);
  assert.equal(c.etStamp(new Date('2026-10-25T22:30:00Z')), '2026-10-25T18:30:00-04:00');
  assert.equal(c.etStamp(new Date('2026-12-01T17:00:00Z')), '2026-12-01T12:00:00-05:00');
});

test('a receipt replays and a tampered one does not', () => {
  const c = sandbox(); vm.runInContext(oracleSrc, c);
  const cast = c.beginCast('tarot:celtic', 'Will the wall be done?');
  const nums = Array.from({ length: 40 }, () => cast.rng());
  const r = c.finishCast(cast, 'x');
  assert.equal(r.n, 40);
  assert.equal(c.replayCast(r.id).ok, true);
  const again = c.replayRng(r);
  assert.deepEqual(Array.from({ length: 40 }, () => again()), nums);
  assert.equal(c.replayCast({ ...r, seed: (r.seed + 1) >>> 0 }).ok, false);
});

test('the same question is not re-rolled unless circumstances changed', () => {
  const c = sandbox(false); vm.runInContext(oracleSrc, c);
  const first = c.beginCast('tarot:ppf', 'Should I call Dana?');
  const a = [first.rng(), first.rng(), first.rng()];
  c.finishCast(first, 'x');
  const second = c.beginCast('tarot:ppf', '  should i call DANA ');
  assert.equal(second.replayed, true);
  assert.equal(second.receipt.id, first.receipt.id);
  assert.deepEqual([second.rng(), second.rng(), second.rng()], a);
  c.finishCast(second, 'x');
  assert.equal(c.loadCasts().length, 1);

  c.confirm = () => true;              // "circumstances have changed"
  const third = c.beginCast('tarot:ppf', 'Should I call Dana?');
  assert.equal(third.replayed, false);
  assert.equal(third.receipt.recast_of, first.receipt.id);
});

test('a blank question is a casual pull and is never gated', () => {
  const c = sandbox(false); vm.runInContext(oracleSrc, c);
  const a = c.beginCast('dice:1d6', ''); c.finishCast(a, '');
  const b = c.beginCast('dice:1d6', '');
  assert.equal(b.replayed, false);
});

test('index.html d20 rolls replay from their receipt', () => {
  const c = sandbox(); vm.runInContext(indexSrc, c);
  const r = c.rollD20s(2);
  assert.equal(r.rolls.length, 2);
  r.rolls.forEach(v => assert.ok(v >= 1 && v <= 20));
  const back = c.replayDiceCast(r.id);
  assert.equal(back.ok, true);
  assert.deepEqual(back.rolls, r.rolls);
});
