// Per-gameId mutex. In-process FIFO queue.
// Prevents two concurrent /turn handlers from racing the same game's state file.
//
// Usage:
//   const release = await acquire(gameId);
//   try { ...turn work... } finally { release(); }

const queues = new Map();  // gameId -> array of waiters (resolve fns)
const held = new Set();    // gameIds currently locked

/**
 * Acquire the per-gameId lock. Resolves immediately if free, otherwise queues.
 * Returns a release function — call exactly once.
 */
export function acquire(gameId) {
  return new Promise(resolve => {
    if (!held.has(gameId)) {
      held.add(gameId);
      resolve(makeReleaseFn(gameId));
      return;
    }
    if (!queues.has(gameId)) queues.set(gameId, []);
    queues.get(gameId).push(() => resolve(makeReleaseFn(gameId)));
  });
}

function makeReleaseFn(gameId) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const q = queues.get(gameId);
    if (q && q.length > 0) {
      const next = q.shift();
      if (q.length === 0) queues.delete(gameId);
      // Hand the lock straight to the next waiter — held stays true.
      next();
    } else {
      held.delete(gameId);
    }
  };
}

/** Diagnostic: is the gameId currently locked? */
export function isHeld(gameId) {
  return held.has(gameId);
}

/** Diagnostic: depth of the wait queue (excluding the current holder). */
export function queueDepth(gameId) {
  return queues.get(gameId)?.length ?? 0;
}
