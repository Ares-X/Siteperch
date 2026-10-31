// Best-effort login throttle held in the warm instance only. It is not shared
// across instances or regions and resets on cold start; it slows online
// password guessing without adding storage, databases or CDN configuration.

const PER_KEY_FAILS = 5, GLOBAL_FAILS = 20, WINDOW_MS = 15 * 60 * 1000, BASE_LOCKOUT_MS = 30 * 1000, MAX_LOCKOUT_MS = 15 * 60 * 1000, MAX_KEYS = 1000;

// Trailing forwarding entries are appended by the hosting platform; leading
// entries can be client-chosen, so the last hop is the most trustworthy key.
export function clientKey(request) {
  const forwarded = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
  return forwarded.split(',').pop().trim() || 'unknown';
}

export function createLoginThrottle({now = () => new Date()} = {}) {
  const global = {fails: 0, firstAt: 0, lockedUntil: 0};
  const keys = new Map();
  const fresh = time => ({fails: 0, firstAt: time, lockedUntil: 0});
  const active = (state, time) => {
    if (time - state.firstAt > WINDOW_MS) { state.fails = 0; state.firstAt = time; state.lockedUntil = 0; }
    return state;
  };
  const blocked = (state, time) => state.lockedUntil > time
    ? {allowed: false, retryAfterSeconds: Math.ceil((state.lockedUntil - time) / 1000)}
    : {allowed: true, retryAfterSeconds: 0};
  const fail = (state, time, limit) => {
    active(state, time);
    state.fails++;
    if (state.fails >= limit) state.lockedUntil = Math.max(state.lockedUntil, time + Math.min(BASE_LOCKOUT_MS * 2 ** (state.fails - limit), MAX_LOCKOUT_MS));
  };
  return {
    check(key) {
      const time = now().getTime();
      const globalState = blocked(global, time);
      if (!globalState.allowed) return globalState;
      // A rotating flood is capped globally; that lock is bounded and expires,
      // trading a short owner-visible 429 for unbounded guessing attempts.
      const state = keys.get(key);
      return state ? blocked(state, time) : globalState;
    },
    recordFailure(key) {
      const time = now().getTime();
      fail(global, time, GLOBAL_FAILS);
      const state = keys.get(key) || fresh(time);
      fail(state, time, PER_KEY_FAILS);
      keys.set(key, state);
      if (keys.size > MAX_KEYS) keys.clear();
    },
    recordSuccess(key) { keys.delete(key); },
  };
}
