export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function readUsage(info) {
  const value = info?.total_token_usage;
  if (!value || !count(value.total_tokens)) return null;
  const validCache = count(value.input_tokens) && value.input_tokens > 0
    && count(value.cached_input_tokens) && value.cached_input_tokens <= value.input_tokens;
  return {
    totalTokens: value.total_tokens,
    cacheHitPercent: validCache ? value.cached_input_tokens / value.input_tokens * 100 : null,
  };
}

export function readQuota(result) {
  const buckets = result?.rateLimitsByLimitId;
  const bucket = buckets && typeof buckets === 'object'
    ? buckets.codex : result?.rateLimits;
  if (!bucket || (bucket.limitId != null && bucket.limitId !== 'codex')) return null;
  const window = [bucket.primary, bucket.secondary].find((item) => item?.windowDurationMins === 300);
  if (!window) return null;
  return {
    remainingPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
      ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null,
    resetsAt: Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0
      && Number.isFinite(new Date(window.resetsAt * 1000).getTime()) ? window.resetsAt : null,
  };
}

export function quotaState(previous, result, error = false) {
  if (error) return { ...previous, stale: true };
  return { value: readQuota(result), stale: false, updatedAt: Date.now() };
}

// Retry failed reads promptly without turning the steady-state minute refresh
// into an unbounded request loop. Time is supplied for deterministic tests.
export function nextQuotaRefresh(previous, now, successful) {
  if (successful) return { failures: 0, nextAttemptAt: now + 60000 };
  const failures = previous.failures + 1;
  const delay = [2000, 5000, 10000, 15000, 30000][Math.min(failures - 1, 4)];
  return { failures, nextAttemptAt: now + delay };
}

export function chooseSnapshot(left, right) {
  if (!left) return right;
  if (!right) return left;
  return right.timestamp > left.timestamp
    || (right.timestamp === left.timestamp && right.order > left.order) ? right : left;
}
