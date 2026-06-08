import { execFileSync, spawnSync } from 'node:child_process';

const PANE_RE = /^%\d+$/;
const DEFAULT_ENTER_RETRY_COUNT = 4;
const DEFAULT_ENTER_DELAY_MS = 250;

export const GJC_MANAGED_TAGS = Object.freeze({
  profile: '@gjc-profile',
  branch: '@gjc-branch',
  branchSlug: '@gjc-branch-slug',
  project: '@gjc-project',
  ownerKey: '@gjc-owner-key',
  startedAt: '@gjc-started-at',
  sessionId: '@gjc-session-id',
});

function runTmux(args) {
  return execFileSync(process.env.TMUX_BIN || 'tmux', args, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function buildManagedMetadata(gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId) {
  return {
    gjcProfile: gjcProfile || '',
    gjcBranch: gjcBranch || '',
    gjcBranchSlug: gjcBranchSlug || '',
    gjcProject: gjcProject || '',
    gjcOwnerKey: gjcOwnerKey || '',
    gjcStartedAt: gjcStartedAt || '',
    gjcSessionId: gjcSessionId || '',
    managed: gjcProfile === '1' && Boolean(gjcBranch) && Boolean(gjcBranchSlug) && Boolean(gjcProject) && Boolean(gjcOwnerKey) && Boolean(gjcStartedAt) && Boolean(gjcSessionId),
  };
}

export function listTmuxPanes() {
  try {
    const output = runTmux([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}	#{pane_id}	#{pane_pid}	#{pane_dead}	#{pane_current_path}	#{@gjc-profile}	#{@gjc-branch}	#{@gjc-branch-slug}	#{@gjc-project}	#{@gjc-owner-key}	#{@gjc-started-at}	#{@gjc-session-id}',
    ]);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const [sessionName, paneId, panePid, paneDead, paneCurrentPath, gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId] = line.split('\t');
      return {
        tmuxId: sessionName,
        tmuxPaneId: paneId,
        panePid: Number.parseInt(panePid, 10),
        paneDead: paneDead === '1',
        paneCurrentPath,
        ...buildManagedMetadata(gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId),
      };
    });
  } catch {
    return [];
  }
}

export function listTmuxSessions() {
  try {
    const output = runTmux([
      'list-sessions',
      '-F',
      '#{session_name}	#{session_created}	#{session_attached}	#{@gjc-profile}	#{@gjc-branch}	#{@gjc-branch-slug}	#{@gjc-project}	#{@gjc-owner-key}	#{@gjc-started-at}	#{@gjc-session-id}',
    ]);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const [tmuxId, createdRaw, attachedRaw, gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId] = line.split('\t');
      return {
        tmuxId,
        createdAt: Number.isFinite(Number(createdRaw)) ? new Date(Number(createdRaw) * 1000).toISOString() : null,
        attached: attachedRaw === '1',
        ...buildManagedMetadata(gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId),
      };
    });
  } catch {
    return [];
  }
}

export function inspectTmuxTarget(target) {
  if (!target || typeof target !== 'string') return null;
  try {
    const output = runTmux([
      'display-message',
      '-p',
      '-t',
      target,
      '#{session_name}	#{pane_id}	#{@gjc-profile}	#{@gjc-branch}	#{@gjc-branch-slug}	#{@gjc-project}	#{@gjc-owner-key}	#{@gjc-started-at}	#{@gjc-session-id}',
    ]);
    if (!output) return null;
    const [tmuxId, tmuxPaneId, gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId] = output.split('\t');
    return {
      tmuxId,
      tmuxPaneId: PANE_RE.test(tmuxPaneId || '') ? tmuxPaneId : null,
      ...buildManagedMetadata(gjcProfile, gjcBranch, gjcBranchSlug, gjcProject, gjcOwnerKey, gjcStartedAt, gjcSessionId),
    };
  } catch {
    return null;
  }
}

export function isManagedTmuxTarget(target, expectations = {}) {
  const targetInfo = typeof target === 'string' ? inspectTmuxTarget(target) : target;
  if (!targetInfo?.managed) return false;
  if (expectations.branch && targetInfo.gjcBranch !== expectations.branch) return false;
  if (expectations.branchSlug && targetInfo.gjcBranchSlug !== expectations.branchSlug) return false;
  if (expectations.project && targetInfo.gjcProject !== expectations.project) return false;
  if (expectations.ownerKey && targetInfo.gjcOwnerKey !== expectations.ownerKey) return false;
  if (expectations.startedAt && targetInfo.gjcStartedAt !== expectations.startedAt) return false;
  if (expectations.sessionId && targetInfo.gjcSessionId !== expectations.sessionId) return false;
  return true;
}

export function sendToTmux(target, text, { submit = true } = {}) {
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'missing tmux target' };
  }
  const safeText = String(text || '').replace(/\r?\n/g, ' ');
  const calls = [['send-keys', '-t', target, '-l', '--', safeText]];
  if (submit) {
    const retryCount = Number.parseInt(process.env.TMUX_SUBMIT_RETRY_COUNT || `${DEFAULT_ENTER_RETRY_COUNT}`, 10);
    const delayMs = Number.parseInt(process.env.TMUX_SUBMIT_DELAY_MS || `${DEFAULT_ENTER_DELAY_MS}`, 10);
    for (let index = 0; index < Math.max(1, retryCount); index += 1) {
      calls.push({ delayMs: Math.max(0, delayMs) });
      calls.push(['send-keys', '-t', target, 'Enter']);
    }
  }
  for (const args of calls) {
    if (!Array.isArray(args)) {
      if (args.delayMs > 0) sleepSync(args.delayMs);
      continue;
    }
    const result = spawnSync(process.env.TMUX_BIN || 'tmux', args, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      return { ok: false, error: result.error?.message || result.stderr || `tmux exited ${result.status}` };
    }
  }
  return { ok: true };
}

export function killTmuxSession(target) {
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'missing tmux target' };
  }
  const result = spawnSync(process.env.TMUX_BIN || 'tmux', ['kill-session', '-t', target], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message || result.stderr || `tmux exited ${result.status}` };
  }
  return { ok: true };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function targetForSession(session) {
  if (session?.tmuxPaneId && PANE_RE.test(session.tmuxPaneId)) return session.tmuxPaneId;
  return session?.tmuxId || null;
}
