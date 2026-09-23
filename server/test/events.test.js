import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, normalizePath, parseDevice } from '../src/lib/events.js';

const ctx = { tenantId: 't1', userAgent: 'Mozilla/5.0 (Windows NT 10.0)', now: 1_700_000_000_000 };

test('normalizePath strips query, hash and trailing slash', () => {
  assert.equal(normalizePath('https://x.com/pricing/?utm=1#top'), '/pricing');
  assert.equal(normalizePath('/blog/post/'), '/blog/post');
  assert.equal(normalizePath('https://x.com'), '/');
  assert.equal(normalizePath('not a url'), null);
});

test('parseDevice classifies common user agents', () => {
  assert.equal(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Mobile'), 'mobile');
  assert.equal(parseDevice('Mozilla/5.0 (iPad; CPU OS 17_5)'), 'tablet');
  assert.equal(parseDevice('Mozilla/5.0 (Linux; Android 14) Safari'), 'tablet');
  assert.equal(parseDevice('Googlebot/2.1'), 'bot');
  assert.equal(parseDevice('Mozilla/5.0 (Windows NT 10.0)'), 'desktop');
  assert.equal(parseDevice(''), 'unknown');
});

test('valid pageview is normalised', () => {
  const { event } = normalizeEvent(
    { type: 'pageview', visitorId: 'v', sessionId: 's', url: 'https://x.com/pricing?a=1', ts: ctx.now - 1000 },
    ctx,
  );
  assert.equal(event.path, '/pricing');
  assert.equal(event.tenantId, 't1');
  assert.equal(event.device, 'desktop');
  assert.equal(event.ts, ctx.now - 1000);
  assert.match(event.eventId, /^[0-9a-f-]{36}$/);
});

test('invalid events are rejected with a reason', () => {
  assert.match(normalizeEvent({ type: 'click' }, ctx).error, /unknown event type/);
  assert.match(normalizeEvent({ type: 'pageview', url: '/' }, ctx).error, /visitorId/);
  assert.match(normalizeEvent({ type: 'pageview', visitorId: 'v', sessionId: 's' }, ctx).error, /url or path/);
  assert.match(normalizeEvent({ type: 'conversion', visitorId: 'v', sessionId: 's' }, ctx).error, /name/);
  assert.match(
    normalizeEvent({ type: 'pageview', visitorId: 'v', sessionId: 's', path: '/', ts: ctx.now - 40 * 86400e3 }, ctx).error,
    /too old/,
  );
});

test('future timestamps are clamped and props are sanitised', () => {
  const { event } = normalizeEvent(
    { type: 'event', name: 'x', visitorId: 'v', sessionId: 's', ts: ctx.now + 3600e3, props: { a: 1, b: { nested: true }, c: 'ok' } },
    ctx,
  );
  assert.equal(event.ts, ctx.now);
  assert.deepEqual(event.props, { a: 1, c: 'ok' });
});
