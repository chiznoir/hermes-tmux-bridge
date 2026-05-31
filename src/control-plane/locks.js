import { randomUUID } from 'node:crypto';

export class LockManager {
  constructor({ now = () => Date.now(), defaultTtlMs = 5 * 60 * 1000 } = {}) {
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.locks = new Map();
  }

  acquire(key, metadata = {}) {
    if (!key) return { ok: true, token: null, key: null, release: () => false };
    const current = this.locks.get(key);
    const now = this.now();
    if (current && current.expiresAt > now) {
      return { ok: false, key, holder: current.metadata, expiresAt: new Date(current.expiresAt).toISOString() };
    }
    const token = randomUUID();
    const expiresAt = now + (metadata.ttlMs || this.defaultTtlMs);
    this.locks.set(key, { token, metadata, expiresAt });
    return { ok: true, key, token, expiresAt: new Date(expiresAt).toISOString(), release: () => this.release(key, token) };
  }

  release(key, token) {
    if (!key) return false;
    const current = this.locks.get(key);
    if (!current || current.token !== token) return false;
    this.locks.delete(key);
    return true;
  }

  isLocked(key) {
    const current = this.locks.get(key);
    if (!current) return false;
    if (current.expiresAt <= this.now()) {
      this.locks.delete(key);
      return false;
    }
    return true;
  }
}

export const commandLocks = new LockManager();

export function lockKeyForSession(session = {}) {
  return session.codexThreadId || session.threadId || session.codexSessionId || session.bridgeSessionId || session.lifecycleSessionId || null;
}
