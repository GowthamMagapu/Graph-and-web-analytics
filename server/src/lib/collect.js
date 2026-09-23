// HTTP routes shared by the full ingest service and lite mode: the tracker
// snippet, the demo site and the event collection endpoint.
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { MAX_BATCH, normalizeEvent, parseDevice } from './events.js';

export function mountTrackerRoutes(app, root) {
  app.get('/tracker.js', cors(), (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.type('application/javascript').sendFile(path.join(root, 'tracker', 'graphpulse.js'));
  });
  app.use('/demo', express.static(path.join(root, 'demo-site')));
}

/**
 * POST /v1/collect - validate tracker events and hand them to `publish`.
 * resolveTenant(apiKey) -> tenantId | null; publish(events) persists or enqueues them.
 */
export function mountCollector(app, { resolveTenant, publish }) {
  // The snippet runs on customer sites, so any origin may post events.
  // sendBeacon/fetch send text/plain to avoid CORS preflights; parse the JSON ourselves.
  app.options('/v1/collect', cors());
  app.post('/v1/collect', cors(), express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
    let body;
    try {
      body = typeof req.body === 'string' && req.body ? JSON.parse(req.body) : {};
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }

    const tenantId = await resolveTenant(req.get('x-graphpulse-key') || body.apiKey);
    if (!tenantId) return res.status(401).json({ error: 'unknown api key' });

    const userAgent = req.get('user-agent') || '';
    if (parseDevice(userAgent) === 'bot') return res.status(202).json({ accepted: 0, skipped: 'bot' });

    const raw = Array.isArray(body.events) ? body.events : [body];
    if (raw.length > MAX_BATCH) return res.status(413).json({ error: `max ${MAX_BATCH} events per request` });

    const now = Date.now();
    const accepted = [];
    const rejected = [];
    raw.forEach((r, index) => {
      const { event, error } = normalizeEvent(r, { tenantId, userAgent, now });
      if (event) accepted.push(event);
      else rejected.push({ index, error });
    });

    if (accepted.length) await publish(accepted);
    res.status(202).json({ accepted: accepted.length, rejected });
  });
}
