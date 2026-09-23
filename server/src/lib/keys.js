// Redis key layout shared by the worker (writer) and the API (reader).
export const minuteOf = (ms) => Math.floor(ms / 60_000);

export const keys = {
  session: (t, sid) => `gp:sess:${t}:${sid}`, // hash { seq, last } - navigation state
  activeVisitors: (t) => `gp:rt:${t}:visitors`, // zset visitorId -> last seen ms
  activeSessions: (t) => `gp:rt:${t}:sessions`, // zset sessionId -> last seen ms
  pageviewsMinute: (t, m) => `gp:rt:${t}:pv:${m}`, // counter per minute
  pagesMinute: (t, m) => `gp:rt:${t}:pages:${m}`, // zset path -> views in that minute
  alertLock: (m) => `gp:lock:alerts:${m}`,
  cooldown: (ruleId) => `gp:cooldown:${ruleId}`,
};

export const REALTIME_WINDOW_MS = 5 * 60_000; // "active now" = seen in the last 5 minutes
export const SESSION_STATE_TTL_S = 2 * 3600;
export const MINUTE_KEY_TTL_S = 3 * 3600;
