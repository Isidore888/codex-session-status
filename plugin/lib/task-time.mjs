import { UUID } from './metrics.mjs';

// Keep only UUID/time metadata. Never retain last_agent_message or attribution text.
export function advanceTask(previous, record) {
  if (record.type !== 'event_msg') return previous;
  const payload = record.payload;
  if (!['task_started', 'task_complete', 'turn_aborted'].includes(payload?.type)) return previous;
  const turnId = payload.turn_id;
  if (typeof turnId !== 'string' || !UUID.test(turnId)
    || (payload.root_turn_id && payload.root_turn_id !== turnId)) return previous;
  const eventAt = Date.parse(record.timestamp);
  if (!Number.isFinite(eventAt)) return previous;
  const suppliedDuration = Number.isSafeInteger(payload.duration_ms) && payload.duration_ms >= 0 ? payload.duration_ms : null;
  const start = Number.isSafeInteger(payload.started_at) && payload.started_at > 0
    ? payload.started_at * 1000 : previous?.turnId === turnId ? previous.startedAt
      : suppliedDuration != null ? eventAt - suppliedDuration : payload.type === 'task_started' ? eventAt : null;
  if (!Number.isFinite(start) || start > eventAt) return previous;
  if (payload.type === 'task_started') {
    return chooseTask(previous, { turnId, startedAt: start, orderAt: eventAt, startObserved: true,
      eventAt, durationMs: null, state: 'running' });
  }
  if (payload.type === 'turn_aborted' && previous?.turnId !== turnId) return previous;
  const durationMs = Number.isSafeInteger(payload.duration_ms) && payload.duration_ms >= 0
    ? payload.duration_ms : Math.max(0, eventAt - start);
  const knownStart = previous?.turnId === turnId ? previous : null;
  return chooseTask(previous, { turnId, startedAt: start, orderAt: knownStart?.orderAt ?? start,
    startObserved: knownStart?.startObserved ?? false, eventAt, durationMs,
    state: payload.type === 'turn_aborted' ? 'aborted' : 'completed' });
}

export function chooseTask(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.turnId === right.turnId) {
    const chosen = left.state !== 'running' && right.state === 'running' ? left
      : right.state !== 'running' && left.state === 'running' ? right
        : right.eventAt > left.eventAt ? right : left;
    const observed = left.startObserved ? left : right.startObserved ? right : chosen;
    return chosen.orderAt === observed.orderAt && chosen.startObserved === observed.startObserved ? chosen
      : { ...chosen, orderAt: observed.orderAt, startObserved: observed.startObserved };
  }
  // started_at is integer seconds. Precise start markers distinguish consecutive
  // roots in that second; a late completion without its start cannot win a tie.
  if (right.startedAt === left.startedAt) {
    if (left.startObserved && !right.startObserved) return left;
    if (right.startObserved && !left.startObserved) return right;
    return right.orderAt > left.orderAt ? right : left;
  }
  return right.startedAt > left.startedAt ? right : left;
}
