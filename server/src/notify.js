// Delivers a fired alert to its rule's channel. Failures are logged, never thrown,
// so one broken webhook can't stop other alerts.
import nodemailer from 'nodemailer';
import { config } from './config.js';

const mailer = config.smtp.host
  ? nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  })
  : null;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function notify(rule, alert) {
  const text = `:rotating_light: GraphPulse alert - ${rule.name}: ${alert.message}`;
  try {
    switch (rule.channel) {
      case 'slack':
        await postJson(rule.target, { text });
        break;
      case 'webhook':
        await postJson(rule.target, { rule: { id: rule.id, name: rule.name }, ...alert });
        break;
      case 'email':
        if (!mailer) {
          console.warn(`[alert] SMTP not configured; would email ${rule.target}: ${alert.message}`);
          break;
        }
        await mailer.sendMail({
          from: config.smtp.from,
          to: rule.target,
          subject: `GraphPulse alert: ${rule.name}`,
          text: alert.message,
        });
        break;
      default:
        console.log(`[alert] ${rule.name}: ${alert.message}`);
    }
  } catch (err) {
    console.error(`[alert] delivery via ${rule.channel} failed for rule ${rule.id}:`, err.message);
  }
}
