import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = new Set(['pageview', 'event', 'conversion']);
export const MAX_BATCH = 100;
const MAX_AGE_MS = 31 * 24 * 3600 * 1000; // allows backfills up to ~1 month
const MAX_SKEW_MS = 5 * 60 * 1000; // client clocks running ahead are clamped to now
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function parseDevice(userAgent = '') {
  if (!userAgent) return 'unknown';
  if (/bot|crawler|spider|crawling|headless/i.test(userAgent)) return 'bot';
  if (/ipad|tablet/i.test(userAgent) || (/android/i.test(userAgent) && !/mobile/i.test(userAgent))) return 'tablet';
  if (/mobi|iphone|android/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

/** "/pricing/?utm=x#top" or "https://site.com/pricing/" -> "/pricing" */
export function normalizePath(value) {
  const raw = str(value, 2048);
  if (!raw) return null;
  let path;
  if (raw.startsWith('/')) {
    path = raw.split(/[?#]/)[0];
  } else {
    try {
      path = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path.slice(0, 512) || '/';
}

function sanitizeProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const out = {};
  for (const [k, v] of Object.entries(props).slice(0, 20)) {
    const key = String(k).slice(0, 64);
    if (typeof v === 'string') out[key] = v.slice(0, 256);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/**
 * Validate and normalise one raw tracker event.
 * Returns { event } on success or { error } with a human-readable reason.
 */
export function normalizeEvent(raw, { tenantId, userAgent = '', now = Date.now() }) {
  if (!raw || typeof raw !== 'object') return { error: 'event must be an object' };
  const { type } = raw;
  if (!EVENT_TYPES.has(type)) return { error: `unknown event type: ${type}` };

  const visitorId = str(raw.visitorId, 64);
  const sessionId = str(raw.sessionId, 64);
  if (!visitorId || !sessionId) return { error: 'visitorId and sessionId are required' };

  let ts = Number(raw.ts ?? now);
  if (!Number.isFinite(ts) || ts > now + MAX_SKEW_MS) ts = now;
  if (ts < now - MAX_AGE_MS) return { error: 'event is too old' };

  const url = str(raw.url, 2048);
  const path = normalizePath(raw.path ?? url);
  if (type === 'pageview' && !path) return { error: 'pageview requires url or path' };

  const name = type === 'pageview' ? null : str(raw.name, 128);
  if (type !== 'pageview' && !name) return { error: `${type} requires a name` };

  return {
    event: {
      eventId: typeof raw.eventId === 'string' && UUID_RE.test(raw.eventId) ? raw.eventId.toLowerCase() : randomUUID(),
      tenantId,
      type,
      name,
      visitorId,
      sessionId,
      url,
      path,
      referrer: str(raw.referrer, 2048),
      title: str(raw.title, 256),
      device: parseDevice(userAgent),
      props: sanitizeProps(raw.props),
      ts: Math.round(ts),
    },
  };
}
