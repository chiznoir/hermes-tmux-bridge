import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { listTmuxPanes } from './tmux.js';

function cleanString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function assertDirectory(path, label) {
  try {
    if (!statSync(path).isDirectory()) return `${label} is not a directory`;
    return null;
  } catch {
    return `${label} does not exist`;
  }
}

function slugify(value) {
  return (String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'project');
}

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(bin, env = process.env) {
  if (isAbsolute(bin) || bin.includes('/')) return canExecute(bin) ? bin : null;
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, bin);
    if (canExecute(candidate)) return candidate;
  }
  return null;
}

export function buildGjcLaunchRequest(body = {}, options = {}) {
  const cwd = resolve(cleanString(body.cwd)
    || cleanString(body.repoPath)
    || cleanString(body.projectRoot)
    || cleanString(options.projectRoot)
    || process.cwd());
  const worktreeRaw = cleanString(body.worktree) || cleanString(body.worktreePath);
  const worktree = worktreeRaw ? resolve(worktreeRaw) : null;
  const bin = cleanString(options.gjcBin) || cleanString(process.env.GJC_BIN) || 'gjc';
  const args = ['--tmux'];
  if (worktree) args.push('--worktree', worktree);
  return {
    requestId: cleanString(body.requestId) || randomUUID(),
    bin,
    cwd,
    worktree,
    args,
  };
}

export function findExistingManagedGjcRunner(request = {}, options = {}) {
  const runPath = request.worktree || request.cwd;
  const project = slugify(basename(runPath || request.cwd || 'project'));
  const panes = typeof options.listTmuxPanesFn === 'function' ? options.listTmuxPanesFn() : listTmuxPanes();
  return panes.find((pane) => pane.managed
    && pane.paneDead !== true
    && pane.gjcBranch === 'gjc'
    && pane.gjcProject === project
    && pane.paneCurrentPath === runPath) || null;
}

export function launchGjcTmuxSession(body = {}, options = {}) {
  if (typeof options.launchGjcSessionFn === 'function') {
    return options.launchGjcSessionFn(body, options);
  }

  const request = buildGjcLaunchRequest(body, options);
  const cwdError = assertDirectory(request.cwd, 'cwd');
  if (cwdError) return { ok: false, reason: 'invalid-cwd', error: cwdError, ...request };
  if (request.worktree) {
    const worktreeError = assertDirectory(request.worktree, 'worktree');
    if (worktreeError) return { ok: false, reason: 'invalid-worktree', error: worktreeError, ...request };
  }

  const existing = findExistingManagedGjcRunner(request, options);
  if (existing) {
    return {
      ok: true,
      backend: 'gjc-tmux',
      status: 'existing',
      reused: true,
      tmuxId: existing.tmuxId,
      tmuxPaneId: existing.tmuxPaneId,
      gjcSessionId: existing.gjcSessionId,
      readiness: 'ready',
      ...request,
    };
  }

  const executable = resolveExecutable(request.bin);
  if (!executable) {
    return { ok: false, reason: 'missing-gjc-bin', error: `gjc executable not found: ${request.bin}`, ...request };
  }

  const child = spawn(executable, request.args, {
    cwd: request.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return {
    ok: true,
    backend: 'gjc-tmux',
    status: 'started',
    readiness: 'pending-discovery',
    pid: child.pid,
    executable,
    ...request,
  };
}
