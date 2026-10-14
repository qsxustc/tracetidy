import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHeaderPreview } from '../src/preview.js';

test('header previews preserve ordinary raw values without escaping them', () => {
  assert.deepEqual(formatHeaderPreview([
    { name: 'Accept', value: 'application/json' },
    { name: 'X-Trace', value: '<private>&"value"' },
  ]), { text: 'Accept: application/json\nX-Trace: <private>&"value"', truncated: false });
});

test('large names and values are cut before full header strings are built', () => {
  const huge = '&'.repeat(20 * 1024 * 1024);
  const valuePreview = formatHeaderPreview([{ name: 'X-Large', value: huge }]);
  assert.equal(valuePreview.text.length, 65_536);
  assert.ok(valuePreview.text.startsWith('X-Large: &'));
  assert.equal(valuePreview.truncated, true);
  assert.equal(formatHeaderPreview([{ name: huge, value: huge }], { maxChars: 32 }).text, '&'.repeat(32));
});

test('non-array input is empty and malformed fields use safe string fallbacks', () => {
  for (const input of [undefined, null, false, 42, 'secret', {}]) {
    assert.deepEqual(formatHeaderPreview(input), { text: '', truncated: false });
  }
  assert.deepEqual(formatHeaderPreview([
    null, 0, false, 'secret', [],
    {}, { name: 12, value: ['do not stringify'] },
    { name: 'Valid', value: null },
  ]), { text: '?: ?\n?: ?\nValid: ?', truncated: false });
});

test('exact character boundaries are complete and one extra character truncates', () => {
  const headers = [{ name: 'A', value: 'one' }, { name: 'B', value: 'two' }];
  assert.deepEqual(formatHeaderPreview(headers, { maxChars: 13 }), { text: 'A: one\nB: two', truncated: false });
  assert.deepEqual(formatHeaderPreview(headers, { maxChars: 12 }), { text: 'A: one\nB: tw', truncated: true });
  assert.deepEqual(formatHeaderPreview(headers, { maxChars: 6 }), { text: 'A: one', truncated: true });
  assert.deepEqual(formatHeaderPreview(headers.slice(0, 1), { maxChars: 6 }), { text: 'A: one', truncated: false });
  assert.deepEqual(formatHeaderPreview([{ name: 'A', value: '' }], { maxChars: 3 }), { text: 'A: ', truncated: false });
});

test('header counts include only records and flag omitted headers', () => {
  const headers = [{ name: 'A', value: 'one' }, null, 'ignored', { name: 'B', value: 'two' }];
  assert.deepEqual(formatHeaderPreview(headers, { maxHeaders: 1 }), { text: 'A: one', truncated: true });
  assert.deepEqual(formatHeaderPreview(headers, { maxHeaders: 2 }), { text: 'A: one\nB: two', truncated: false });
  assert.deepEqual(formatHeaderPreview(headers.slice(0, 3), { maxHeaders: 1 }), { text: 'A: one', truncated: false });
  const many = Array.from({ length: 300 }, () => ({ name: 'X', value: '&' }));
  const preview = formatHeaderPreview(many);
  assert.equal(preview.text.split('\n').length, 200);
  assert.equal(preview.truncated, true);
});

test('zero budgets are bounded and empty inputs never claim omitted headers', () => {
  const header = [{ name: 'X', value: '&' }];
  for (const options of [{ maxChars: 0 }, { maxHeaders: 0 }, { maxChars: 0, maxHeaders: 0 }]) {
    assert.deepEqual(formatHeaderPreview(header, options), { text: '', truncated: true });
    assert.deepEqual(formatHeaderPreview([], options), { text: '', truncated: false });
    assert.deepEqual(formatHeaderPreview([null, 'ignored'], options), { text: '', truncated: false });
  }
});

test('invalid options fall back to bounded defaults without coercing values', () => {
  const headers = [{ name: 'X', value: '&'.repeat(100_000) }];
  for (const options of [null, false, 'invalid', [], {
    maxChars: Infinity, maxHeaders: '1',
  }, { maxChars: -1, maxHeaders: -1 }, { maxChars: 0.5, maxHeaders: NaN }, {
    maxChars: Number.MAX_SAFE_INTEGER + 1, maxHeaders: Number.MAX_SAFE_INTEGER + 1,
  }]) {
    const preview = formatHeaderPreview(headers, options);
    assert.equal(preview.text.length, 65_536);
    assert.equal(preview.truncated, true);
  }
});

test('complete outputs respect both configured limits across small budgets', () => {
  const headers = Array.from({ length: 40 }, (_, index) => ({ name: `H${index}`, value: '&'.repeat(index) }));
  for (let maxChars = 0; maxChars <= 100; maxChars += 1) {
    for (let maxHeaders = 0; maxHeaders <= 5; maxHeaders += 1) {
      const preview = formatHeaderPreview(headers, { maxChars, maxHeaders });
      assert.ok(preview.text.length <= maxChars);
      assert.ok(preview.text.split('\n').length <= Math.max(1, maxHeaders));
      assert.equal(preview.truncated, true);
    }
  }
});
