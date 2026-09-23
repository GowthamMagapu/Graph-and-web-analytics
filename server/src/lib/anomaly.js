/**
 * Z-score anomaly check of the latest value against a trailing baseline.
 * The std-dev is floored at sqrt(mean) (Poisson noise) so a flat, low-traffic
 * baseline doesn't turn every small wobble into an alert.
 */
export function detectAnomaly(baseline, value, { zThreshold = 3, minBaselinePoints = 10 } = {}) {
  if (baseline.length < minBaselinePoints) return { isAnomaly: false, reason: 'insufficient baseline' };
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length;
  const std = Math.max(Math.sqrt(variance), Math.sqrt(mean), 1);
  const z = (value - mean) / std;
  return {
    isAnomaly: Math.abs(z) >= zThreshold,
    direction: z >= 0 ? 'spike' : 'drop',
    mean,
    std,
    z,
  };
}

/** Evaluate one alert rule against the latest per-minute value. Returns a message or null. */
export function evaluateRule(rule, value, baseline) {
  switch (rule.condition) {
    case 'above':
      return value > rule.threshold ? `${rule.metric} is ${value}, above threshold ${rule.threshold}` : null;
    case 'below':
      return value < rule.threshold ? `${rule.metric} is ${value}, below threshold ${rule.threshold}` : null;
    case 'anomaly': {
      const r = detectAnomaly(baseline, value, { zThreshold: rule.threshold || 3 });
      return r.isAnomaly
        ? `Traffic ${r.direction}: ${rule.metric} is ${value} vs. baseline ${r.mean.toFixed(1)} (z=${r.z.toFixed(1)})`
        : null;
    }
    default:
      return null;
  }
}
