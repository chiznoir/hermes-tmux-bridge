import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { commandLocks } from './control-plane/locks.js';
import { startDiscordNotifier } from './discord-notifier.js';
import { startHermesWebhookSink } from './hermes-webhook-sink.js';
import { dispatchBridgeRoute, isMutatingMethod } from './server-routes.js';

const DEFAULT_PORT = 3037;
const DEFAULT_CONTROL_SESSION_SCAN_LIMIT = 50;
const PRE_COMMAND_TERMINAL_EVENT_TYPES = new Set(['FinalAnswer', 'AgentResponse']);

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: 'not_found' });
}

function methodNotAllowed(res) {
  json(res, 405, { error: 'method_not_allowed' });
}

function unauthorized(res) {
  json(res, 401, { error: 'unauthorized' });
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function isAuthorized(req, authToken) {
  if (!authToken) return true;
  const token = bearerToken(req);
  return token ? safeEqualString(token, authToken) : false;
}

function positiveInt(value, defaultValue = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function controlSessionScanLimit(options = {}) {
  return positiveInt(
    process.env.BRIDGE_CONTROL_SESSION_SCAN_LIMIT
      || process.env.BRIDGE_SESSION_SCAN_LIMIT
      || options.sessionScanLimit,
    DEFAULT_CONTROL_SESSION_SCAN_LIMIT,
  );
}

export function createCommandNotificationFlusher({ notifier = null, hermesSink = null } = {}) {
  const hasNotifier = notifier?.started && typeof notifier.flush === 'function';
  const hasHermesSink = hermesSink?.started && typeof hermesSink.flush === 'function';
  if (!hasNotifier && !hasHermesSink) return null;
  return async (payload = {}) => {
    if (hasHermesSink) {
      await hermesSink.flush({
        reason: 'pre-command-terminal',
        eventTypes: new Set(PRE_COMMAND_TERMINAL_EVENT_TYPES),
      });
    }
    if (hasNotifier) {
      await notifier.flush(payload);
    }
  };
}

function createRouter(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const indexOptions = {
    cwd: projectRoot,
    includeUnmappedCodexLogs: true,
    unmappedCodexLogLimit: 30,
    sessionScanLimit: controlSessionScanLimit(options),
    ...options,
    projectRoot,
  };
  const lockManager = options.lockManager || commandLocks;
  const authToken = options.authToken ?? process.env.BRIDGE_TOKEN ?? '';

  return async function router(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true });
      }

      if (!isAuthorized(req, authToken)) return unauthorized(res);

      if (await dispatchBridgeRoute({
        req,
        res,
        url,
        parts,
        indexOptions,
        projectRoot,
        options,
        lockManager,
        json,
        notFound,
      })) return;

      if (isMutatingMethod(req.method)) return methodNotAllowed(res);
      return notFound(res);
    } catch (error) {
      return json(res, 500, { error: 'internal_error', message: error?.message || String(error) });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createRouter(options));
}

export function resolveRuntimeProjectRoot(env = process.env, cwd = process.cwd()) {
  return env.PROJECT_ROOT || cwd;
}

async function main() {
  const port = Number.parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10);
  const host = process.env.HOST || '127.0.0.1';
  const projectRoot = resolveRuntimeProjectRoot();
  const commandNotificationFlushers = [];
  const server = createServer({ projectRoot, commandNotificationFlushers });
  const notifier = startDiscordNotifier({ projectRoot });
  const hermesSink = startHermesWebhookSink({ projectRoot });
  const commandNotificationFlusher = createCommandNotificationFlusher({ notifier, hermesSink });
  if (commandNotificationFlusher) commandNotificationFlushers.push(commandNotificationFlusher);
  server.listen(port, host, () => {
    console.log(`hermes-codex-bridge listening on http://${host}:${port}`);
    if (notifier.started) console.log('bridge Discord notifier enabled');
    if (hermesSink.started) console.log('bridge Hermes webhook sink enabled');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
