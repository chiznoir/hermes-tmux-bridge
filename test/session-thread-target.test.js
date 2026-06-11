import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCreateMissingSessionThread } from '../src/session-thread-target.js';

test('shouldCreateMissingSessionThread rejects raw UUID session names without human lifecycle identity', () => {
  const rawId = '019e3f1d-44e2-7c22-98f2-042dd62bff1e';
  assert.equal(shouldCreateMissingSessionThread({ type: 'CommandSubmitted' }, {
    session: {
      hasOmxLifecycle: true,
      bridgeSessionId: rawId,
      codexSessionId: rawId,
      project: 'omx-bridge',
    },
  }), false);
});

test('shouldCreateMissingSessionThread allows explicit or human session thread names', () => {
  assert.equal(shouldCreateMissingSessionThread({ type: 'SessionStart' }, {
    session: {
      hasOmxLifecycle: true,
      tmuxId: 'omx-omx-bridge-173333',
      codexSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
      project: 'omx-bridge',
    },
  }), true);
  assert.equal(shouldCreateMissingSessionThread({ type: 'CommandSubmitted' }, {
    discordThreadName: 'manual-thread-name',
    session: {
      hasOmxLifecycle: true,
      bridgeSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
      codexSessionId: '019e3f1d-44e2-7c22-98f2-042dd62bff1e',
    },
  }), true);
});

test('shouldCreateMissingSessionThread allows managed GJC sessions despite raw GJC ids', () => {
  assert.equal(shouldCreateMissingSessionThread({ type: 'SessionStart' }, {
    session: {
      backend: 'gjc',
      lifecycleOwner: 'gjc',
      hasOmxLifecycle: false,
      gjcSessionId: '019e9000-5555-7000-aaaa-ffffffffffff',
      bridgeSessionId: '019e9000-5555-7000-aaaa-ffffffffffff',
      project: 'hermes-tmux-bridge',
    },
  }), true);
  assert.equal(shouldCreateMissingSessionThread({ type: 'FinalAnswer' }, {
    session: {
      backend: 'gjc',
      lifecycleOwner: 'gjc',
      hasOmxLifecycle: false,
      gjcSessionId: '019e9000-5555-7000-aaaa-ffffffffffff',
      bridgeSessionId: '019e9000-5555-7000-aaaa-ffffffffffff',
      project: 'hermes-tmux-bridge',
    },
  }), true);
});
