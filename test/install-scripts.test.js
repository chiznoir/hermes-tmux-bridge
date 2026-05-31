import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCallback);

async function tempEnv() {
  const home = await mkdtemp(join(tmpdir(), 'hermes-codex-bridge-install-'));
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    HOST: '',
    PORT: '',
    BRIDGE_HERMES_WEBHOOK_URL: '',
    BRIDGE_HERMES_WEBHOOK_SECRET: '',
    BRIDGE_HERMES_DEFAULT_CHANNEL_ID: '',
    BRIDGE_HERMES_PROJECT_CHANNEL_MAP: '',
    BRIDGE_DISCORD_BOT_TOKEN: '',
    BRIDGE_DISCORD_GUILD_ID: '',
    BRIDGE_DISCORD_AUTO_CREATE_THREADS: '',
    DISCORD_BOT_TOKEN: '',
    DISCORD_GUILD_ID: '',
    DISCORD_SERVER_ID: '',
  };
}

test('.env.example is safe to source and keeps recommended values opt-in', async () => {
  const env = await tempEnv();
  await execFile('bash', [
    '-lc',
    'set -euo pipefail; set -a; . ./.env.example; set +a; test -z "${BRIDGE_HERMES_WEBHOOK_ENABLED:-}"; test -z "${BRIDGE_DISCORD_BOT_TOKEN:-}"; test -z "${HOST:-}"; test -z "${PORT:-}"',
  ], { env, cwd: process.cwd(), maxBuffer: 1024 * 1024 });
});

test('install-systemd-service does not enable Hermes webhook sink from channel mapping alone', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--map', join(env.HOME, 'project-channels.json'),
    '--channel', 'fallback-channel',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_ENABLED=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_URL=/);
  assert.match(stdout, /Hermes sink:\s+false/);
});

test('install-systemd-service quotes PATH for systemd Environment entries', async () => {
  const env = await tempEnv();
  env.PATH = '/tmp/a path:/usr/bin:/bin';
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--npm', '/usr/bin/npm',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Environment="PATH=\/tmp\/a path:\/usr\/bin:\/bin"/);
});

test('install-systemd-service enables Discord fast-path events with Hermes bot routing', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--sink',
    '--secret', 'secret',
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--alert-channel', '123456789012345678',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /^HOST=/m);
  assert.doesNotMatch(stdout, /^PORT=/m);
  assert.doesNotMatch(stdout, /^BRIDGE_PUBLIC_URL=/m);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_WEBHOOK_EVENT_TYPES=AskPermission,FinalAnswer/);
  assert.match(stdout, /BRIDGE_DISCORD_FAST_EVENTS_ENABLED=true/);
  assert.match(stdout, /BRIDGE_NOTIFY_INCLUDE_UNMAPPED_CODEX_LOGS=true/);
  assert.match(stdout, /DISCORD_ALERT_CHANNEL_ID=123456789012345678/);
  assert.match(stdout, /BRIDGE_DISCORD_MENTION_USERS=456789012345678901/);
});

test('install-systemd-service can enable Discord session thread creation explicitly', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--sink',
    '--secret', 'secret',
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--threads',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /BRIDGE_DISCORD_AUTO_CREATE_THREADS=true/);
});

test('install-systemd-service enables Hermes allowlist without default restart env noise', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-systemd-service.sh',
    '--dry-run',
    '--no-start',
    '--repo-root', process.cwd(),
    '--config', join(env.HOME, '.hermes', 'config.yaml'),
    '--restart-cmd', 'systemctl --user restart --no-block hermes-gateway.service',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.doesNotMatch(stdout, /BRIDGE_DISCORD_AUTO_CREATE_THREADS=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_CONFIG=.*config\.yaml/);
  assert.match(stdout, /BRIDGE_HERMES_ALLOWLIST=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_RESTART=true/);
  assert.doesNotMatch(stdout, /BRIDGE_HERMES_RESTART_CMD=systemctl --user restart --no-block hermes-gateway\.service/);
});


test('bin/install.sh installs only core bridge helper symlinks', async () => {
  const env = await tempEnv();
  const targetDir = join(env.HOME, 'bin');
  const { stdout } = await execFile('bash', [
    'bin/install.sh',
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Installed symlink: .*codex-new/);
  assert.match(stdout, /Installed symlink: .*codex-send/);
  assert.match(stdout, /Installed symlink: .*codex-kill/);
  assert.doesNotMatch(stdout, /codex-bootstrap|codex-status|codex-sync|codex-cleanup/);
  assert.equal(await readlink(join(targetDir, 'codex-new')), join(process.cwd(), 'bin', 'codex-new'));
  assert.equal(await readlink(join(targetDir, 'codex-send')), join(process.cwd(), 'bin', 'codex-send'));
  assert.equal(await readlink(join(targetDir, 'codex-kill')), join(process.cwd(), 'bin', 'codex-kill'));
});

test('install-codex-cli installs bridge helper symlinks', async () => {
  const env = await tempEnv();
  const targetDir = join(env.HOME, 'bin');
  const { stdout } = await execFile('bash', [
    'scripts/install-codex-cli.sh',
    '--repo-root', process.cwd(),
    '--dir', targetDir,
    '--force',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /Installed symlink: .*codex-new/);
  assert.match(stdout, /Installed symlink: .*codex-send/);
  assert.match(stdout, /Installed symlink: .*codex-kill/);
  assert.equal(await readlink(join(targetDir, 'codex-new')), join(process.cwd(), 'bin', 'codex-new'));
  assert.equal(await readlink(join(targetDir, 'codex-send')), join(process.cwd(), 'bin', 'codex-send'));
  assert.equal(await readlink(join(targetDir, 'codex-kill')), join(process.cwd(), 'bin', 'codex-kill'));
});

test('apply-runtime dry-run shows the user service restart and health check plan', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/apply-runtime.sh',
    '--dry-run',
    '--name', 'test-bridge',
    '--port', '3999',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /scope: user/);
  assert.match(stdout, /service: test-bridge\.service/);
  assert.match(stdout, /\+ systemctl --user daemon-reload/);
  assert.match(stdout, /\+ systemctl --user restart test-bridge\.service/);
  assert.match(stdout, /http:\/\/127\.0\.0\.1:3999\/health/);
  assert.match(stdout, /\+ curl -fsS http:\/\/127\.0\.0\.1:3999\/health/);
});

test('apply-runtime can target a system service and skip health checks', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/apply-runtime.sh',
    '--dry-run',
    '--system',
    '--skip-health',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /scope: system/);
  assert.match(stdout, /health: skipped/);
  assert.match(stdout, /\+ systemctl daemon-reload/);
  assert.match(stdout, /\+ systemctl restart hermes-codex-bridge\.service/);
  assert.doesNotMatch(stdout, /\+ curl/);
});

test('install-hermes-stack defaults to Hermes agent bridge without webhook sink', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /install-codex-cli\.sh/);
  assert.match(stdout, /--force/);
  assert.match(stdout, /Mode: Hermes agent bridge/);
  assert.match(stdout, /Helper CLIs:/);
  assert.match(stdout, /remove Hermes webhook subscription codex-bridge/);
  assert.doesNotMatch(stdout, /--sink(?:\s|$)/);
  assert.doesNotMatch(stdout, /install\/update Hermes webhook subscription/);
});

test('install-hermes-stack only enables webhook sink when explicitly requested', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--webhook',
    '--channel', 'fallback-channel',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--sink(?:\s|$)/);
  assert.match(stdout, /install\/update Hermes webhook subscription codex-bridge/);
  assert.match(stdout, /Mode: Hermes webhook sink/);
});

test('install-hermes-stack maps Hermes Discord env into bridge service defaults', async () => {
  const env = await tempEnv();
  const hermesHome = join(env.HOME, '.hermes');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, '.env'), [
    'DISCORD_BOT_TOKEN=dummy-bot-token',
    'DISCORD_GUILD_ID=guild-1',
    'DISCORD_HOME_CHANNEL=fallback-channel',
    'DISCORD_ALERT_CHANNEL_ID=123456789012345678',
    '',
  ].join('\n'));

  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--webhook',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--hermes-home', hermesHome,
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--bot-token \\<redacted\\>/);
  assert.match(stdout, /--guild guild-1/);
  assert.match(stdout, /--alert-channel 123456789012345678/);
  assert.match(stdout, /--channel fallback-channel/);
  assert.doesNotMatch(stdout, /dummy-bot-token/);
});

test('install-hermes-stack forwards Discord session thread creation to service installer', async () => {
  const env = await tempEnv();
  const { stdout } = await execFile('bash', [
    'scripts/install-hermes-stack.sh',
    '--dry-run',
    '--webhook',
    '--non-interactive',
    '--no-start',
    '--repo-root', process.cwd(),
    '--channel', 'fallback-channel',
    '--bot-token', 'secret-discord-token',
    '--guild', 'guild-1',
    '--threads',
    '--mention-users', '456789012345678901',
  ], { env, maxBuffer: 1024 * 1024 });

  assert.match(stdout, /--threads/);
  assert.match(stdout, /--mention-users 456789012345678901/);
  assert.doesNotMatch(stdout, /secret-discord-token/);
});

test('core worktree does not expose extension helper scripts', async () => {
  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server.js');

  const binReadme = await readFile(join(process.cwd(), 'bin', 'README.md'), 'utf8');
  assert.match(binReadme, /codex-new/);
  assert.match(binReadme, /codex-send/);
  assert.match(binReadme, /codex-kill/);
  for (const removed of ['bootstrap', 'status', 'sync', 'cleanup'].map((name) => `codex-${name}`)) {
    assert.equal(binReadme.includes(removed), false);
  }
});
