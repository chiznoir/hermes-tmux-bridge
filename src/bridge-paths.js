import { join } from 'node:path';
import { homedir } from 'node:os';

export function expandHome(path) {
  const value = String(path || '');
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export function bridgeStateRoot(options = {}) {
  return expandHome(
    options.bridgeStateRoot
    || process.env.BRIDGE_STATE_ROOT
    || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'hermes-codex-bridge'),
  );
}

export function bridgeStatePath(fileName, options = {}) {
  return join(bridgeStateRoot(options), fileName);
}
