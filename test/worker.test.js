import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { SECURITY_HEADERS } from '../src/worker.js';

test('worker serves ASSETS and adds security headers to every response', async () => {
  for (const status of [200, 404, 304]) {
    const env = { ASSETS: { fetch: async () => new Response(status === 304 ? null : 'x', { status, headers: { 'content-type': 'text/html' } }) } };
    const res = await worker.fetch(new Request('https://example.com/'), env);
    assert.equal(res.status, status);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'; connect-src 'none'; img-src 'self' blob: data:; media-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('content-type'), 'text/html');
  }
  assert.equal(Object.keys(SECURITY_HEADERS).length, 3);
});
