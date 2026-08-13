import test from 'node:test';

test('project regression suite', async () => {
  await import('./regression-tests.mjs');
});
