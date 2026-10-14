// Executed inside Codex: reuse its authenticated request channel; export quota fields only.
export async function readDesktopQuota() {
  const root = window.__codexRoot?._internalRoot?.current;
  if (!root) throw new Error('desktop-request-root-unavailable');
  const deadline = performance.now() + 500;
  const queue = [];
  const value = (object, key) => {
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  };
  const add = (object) => {
    if (object && (typeof object === 'object' || typeof object === 'function') && queue.length < 200000) queue.push(object);
  };
  // Seed from the mounted Fiber tree before traversing large caches/DOM graphs.
  // The native request manager is held in a hook ref; ordinary breadth-first
  // traversal exhausted its budget before reaching that ref in a populated app.
  const fibers = [root];
  const visitedFibers = new WeakSet();
  for (let cursor = 0; cursor < fibers.length && cursor < 20000; cursor++) {
    if (cursor % 256 === 0 && performance.now() > deadline) break;
    const fiber = fibers[cursor];
    if (!fiber || typeof fiber !== 'object' || visitedFibers.has(fiber)) continue;
    visitedFibers.add(fiber);
    for (const key of ['child', 'sibling']) {
      const next = value(fiber, key);
      if (next && fibers.length < 40000) fibers.push(next);
    }
    add(value(fiber, 'memoizedProps'));
    let dependency = value(value(fiber, 'dependencies'), 'firstContext');
    for (let count = 0; dependency && count < 20; count++, dependency = value(dependency, 'next')) add(value(dependency, 'memoizedValue'));
    let hook = value(fiber, 'memoizedState');
    for (let count = 0; hook && count < 100; count++, hook = value(hook, 'next')) {
      add(value(hook, 'memoizedState'));
      add(value(hook, 'baseState'));
      add(value(value(hook, 'queue'), 'lastRenderedState'));
    }
  }
  add(root); // Retain support for simple roots and isolated compatibility fixtures.
  const seen = new WeakSet();
  let client = null;
  const requestClient = (owner) => {
    if (value(owner, 'hostId') !== 'local' || !(value(owner, 'requestPromises') instanceof Map)) return null;
    let sendRequest = value(owner, 'sendRequest');
    if (!sendRequest) {
      try { sendRequest = value(Object.getPrototypeOf(owner), 'sendRequest'); } catch {}
    }
    return typeof sendRequest === 'function' ? { owner, sendRequest } : null;
  };
  for (let cursor = 0; cursor < queue.length && cursor < 100000; cursor++) {
    if (cursor % 256 === 0 && performance.now() > deadline) break;
    const item = queue[cursor];
    if (!item || (typeof item !== 'object' && typeof item !== 'function') || seen.has(item)) continue;
    seen.add(item);
    if (item === window || (typeof Node !== 'undefined' && item instanceof Node)) continue;
    // Descriptor reads never invoke application getters while traversing the object graph.
    let properties;
    try { properties = Object.getOwnPropertyDescriptors(item); } catch { continue; }
    client = requestClient(item);
    // The verified local manager owns its lower-level authenticated request client.
    if (!client && properties.hostId?.value === 'local') client = requestClient(properties.requestClient?.value);
    if (client) break;
    if (item instanceof Map) {
      for (const [key, entry] of item) { add(key); add(entry); }
    } else if (item instanceof Set) {
      for (const entry of item) add(entry);
    }
    for (const descriptor of Object.values(properties)) {
      if ('value' in descriptor && descriptor.value
        && (typeof descriptor.value === 'object' || typeof descriptor.value === 'function')) {
        add(descriptor.value);
      }
    }
    if (queue.length > 200000) break;
  }
  if (!client) throw new Error('desktop-request-client-unavailable');
  const result = await client.sendRequest.call(client.owner, 'account/rateLimits/read', undefined, {
    priority: 'background', source: 'codex_session_status', timeoutMs: 10000,
  });
  if (!result || (!Object.hasOwn(result, 'rateLimitsByLimitId') && !Object.hasOwn(result, 'rateLimits'))) {
    throw new Error('desktop-quota-response-unavailable');
  }
  const byId = result.rateLimitsByLimitId;
  const source = byId && typeof byId === 'object' ? byId.codex : result.rateLimits;
  if (!source || (source.limitId != null && source.limitId !== 'codex')) return { rateLimits: null };
  const copyWindow = (value) => value ? {
    usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins, resetsAt: value.resetsAt,
  } : null;
  return { rateLimits: { limitId: 'codex', primary: copyWindow(source.primary), secondary: copyWindow(source.secondary) } };
}
export const quotaExpression = '(' + readDesktopQuota.toString() + ')()';
// Missing managers and search timeouts can recover; never export raw app errors.
export const quotaProbeExpression = '(' + readDesktopQuota.toString()
  + ')().then(value=>({value}),()=>({code:"request-failed"}))';
