// Best-effort login throttle held in the warm instance only. It is not shared
// across instances or regions and resets on cold start.
const PER_KEY_FAILS = 5, GLOBAL_FAILS = 20, WINDOW_MS = 15 * 60 * 1000, BASE_LOCKOUT_MS = 30 * 1000, MAX_LOCKOUT_MS = 15 * 60 * 1000;

export function createLoginThrottle({now = () => new Date()} = {}) {
  const fresh = time => ({fails: 0, inFlight: 0, firstAt: time, lockedUntil: 0});
  const global = fresh(now().getTime());
  const keys = new Map();
  const active = (state, time) => {
    if (time - state.firstAt >= WINDOW_MS) { state.fails = 0; state.firstAt = time; state.lockedUntil = 0; }
    return state;
  };
  const wait = (state, time, limit) => state.lockedUntil > time
    ? Math.ceil((state.lockedUntil - time) / 1000)
    : state.inFlight >= Math.max(1, limit - state.fails) ? 1 : 0;
  const fail = (state, time, limit) => {
    active(state, time);
    state.fails++;
    if (state.fails >= limit) state.lockedUntil = Math.max(state.lockedUntil, time + Math.min(BASE_LOCKOUT_MS * 2 ** (state.fails - limit), MAX_LOCKOUT_MS));
  };
  return {
    reserve(key) {
      const time = now().getTime();
      active(global, time);
      // Failed-client entries expire with the failure window; successful and
      // malformed attempts are removed as soon as their last reservation ends.
      for (const [client, state] of keys) if (!state.inFlight && time - state.firstAt >= WINDOW_MS) keys.delete(client);
      const state = keys.get(key) || fresh(time);
      active(state, time);
      const retryAfterSeconds = Math.max(wait(global, time, GLOBAL_FAILS), wait(state, time, PER_KEY_FAILS));
      if (retryAfterSeconds) return {allowed: false, retryAfterSeconds};
      keys.set(key, state);
      global.inFlight++; state.inFlight++;
      return {allowed: true, finish(outcome) {
        global.inFlight--; state.inFlight--;
        if (outcome === 'failure') {
          const finishedAt = now().getTime();
          fail(global, finishedAt, GLOBAL_FAILS); fail(state, finishedAt, PER_KEY_FAILS);
        } else if (outcome === 'success') { state.fails = 0; state.lockedUntil = 0; }
        if (!state.inFlight && !state.fails) keys.delete(key);
      }};
    },
  };
}
