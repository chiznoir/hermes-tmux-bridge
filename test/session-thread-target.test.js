import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCreateMissingSessionThread } from '../src/session-thread-target.js';

test('shouldCreateMissingSessionThread rejects raw UUID session names without human lifecycle identity', () => {
  const rawId = '019e3f1d-44e2-7c22-98f2-042dd62bff1e';
  assert.equal(shouldCreateMissingSessionThread({ type: 'CommandSubmitted' }, {
    session: {
      hasBridgeLifecycle: true,
      bridgeSessionId: rawId,
      codexSessionId: rawId,
      project: 'codex-bridge',
    },
  }), false);
});

test('shouldCreateMissingSessionThread allows explicit or human session thread names', () => {
  assert.equal(shouldCreateMissingSessionThread({ type: 'SessionStart' }, {
    session: {
      hasBridgeLifecycle: true,
      tmuxId: 'codex-codex-bridge-173333',
      codexSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
      project: 'codex-bridge',
    },
  }), true);
  assert.equal(shouldCreateMissingSessionThread({ type: 'CommandSubmitted' }, {
    discordThreadName: 'manual-thread-name',
    session: {
      hasBridgeLifecycle: true,
      bridgeSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
      codexSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
    },
  }), true);
});
