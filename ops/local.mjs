import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, lstat, rename, chmod, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { encryptProcessBackup, withVerifiedBackup } from './backup.mjs';
const images = JSON.parse(await readFile(new URL('./images.json', import.meta.url)));
let localEndpoint;
export function dockerBoundary() {
  if (!localEndpoint) {
    const candidate = process.env.DOCKER_HOST || JSON.parse(execFileSync('docker', ['context', 'inspect', ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!/^unix:\/\/\/[A-Za-z0-9_./-]+$/.test(candidate)) throw Error('Only a local Unix Docker endpoint is supported');
    localEndpoint = candidate;
  }
  const env = { ...process.env }; delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
  return { prefix: ['--host', localEndpoint], env };
}
export const docker = (args, options = {}) => {
  const boundary = dockerBoundary();
  try { return execFileSync('docker', [...boundary.prefix, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, ...options, env: boundary.env }).trim(); }
  catch (cause) {
    const error = Error(`Docker ${args[0]} failed; inspect only sanitized service diagnostics`);
    error.execution = { status: Number.isInteger(cause.status) ? cause.status : null, signal: typeof cause.signal === 'string' ? cause.signal : null, code: typeof cause.code === 'string' ? cause.code : null };
    const message = String(cause.stderr ?? '');
    error.category = /address pools|non-overlapping IPv4 address pool/i.test(message) ? 'network-address-pool' : /network.*(?:not found|failed|error|external)|failed to create network/i.test(message) ? 'network' : /unhealthy/i.test(message) ? 'unhealthy' : /exited/i.test(message) ? 'container-exited' : 'unclassified';
    throw error;
  }
};
export const compose = (project, args, options) => { assertOwnership(project); return docker(['compose', '--project-name', project.name, '--file', join(project.directory, 'compose.yaml'), ...args], options); };
export function startPostgres(project) {
  const started = Date.now();
  try { return compose(project, ['up', '-d', '--wait', 'postgres']); }
  catch (error) {
    const diagnostic = { observedAt: new Date().toISOString(), elapsedMs: Date.now() - started, execution: error.execution ?? null, category: error.category ?? 'unclassified', containers: [], captureComplete: false };
    try {
      const deadline = Date.now() + 5000;
      const bounded = args => { const timeout = deadline - Date.now(); if (timeout <= 0) throw Error('Diagnostic budget exhausted'); return docker(args, { timeout, killSignal: 'SIGKILL', maxBuffer: 65536 }); };
      const ids = bounded(['ps', '-aq', '--no-trunc', '--filter', 'label=credspan.deployment=' + project.deploymentId, '--filter', 'label=com.docker.compose.project=' + project.name, '--filter', 'label=com.docker.compose.service=postgres']).split('\n').filter(Boolean);
      if (ids.length > 4) throw Error('Unexpected PostgreSQL container count');
      for (const id of ids) {
        const record = JSON.parse(bounded(['inspect', id, '--format', '{"id":{{json .Id}},"state":{{json .State}},"labels":{{json .Config.Labels}}}']));
        if (record.id !== id || record.labels?.['credspan.deployment'] !== project.deploymentId || record.labels?.['com.docker.compose.project'] !== project.name || record.labels?.['com.docker.compose.service'] !== 'postgres') throw Error('Diagnostic ownership changed');
        const state = record.state;
        const boundary = dockerBoundary(), captured = spawnSync('docker', [...boundary.prefix, 'logs', '--tail', '40', id], { env: boundary.env, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 65536 });
        if (Date.now() >= deadline || captured.status !== 0) throw Error('Scoped PostgreSQL logs unavailable');
        const logs = String(captured.stdout ?? '') + String(captured.stderr ?? '');
        const logSignals = { ready: /database system is ready to accept connections/.test(logs), permissionDenied: /Permission denied/.test(logs), noSpace: /No space left on device/.test(logs), invalidCheckpoint: /invalid checkpoint|could not locate a valid checkpoint/.test(logs), shutdown: /database system is shut down/.test(logs) };
        diagnostic.containers.push({ id, logSignals, status: state.Status, exitCode: state.ExitCode, oomKilled: state.OOMKilled, startedAt: state.StartedAt, finishedAt: state.FinishedAt, daemonError: Boolean(state.Error), health: state.Health ? { status: state.Health.Status, failingStreak: state.Health.FailingStreak, attempts: (state.Health.Log ?? []).slice(-5).map(item => ({ start: item.Start, end: item.End, exitCode: item.ExitCode })) } : null });
      }
      diagnostic.captureComplete = true;
    } catch { /* Keep the original failure and explicitly mark incomplete capture. */ }
    console.error(JSON.stringify({ postgresStartup: diagnostic }));
    throw error;
  }
}
export function down(project, { removeVolumes = false } = {}) { return compose(project, ['--profile', 'holder', 'down', ...(removeVolumes ? ['--volumes', '--remove-orphans'] : [])]); }
export function assertOwnership(project) {
  for (const [command, filter] of [['ps', 'label=com.docker.compose.project='], ['volume', 'label=com.docker.compose.project='], ['network', 'label=com.docker.compose.project=']]) {
    const args = command === 'ps' ? ['ps', '-a'] : [command, 'ls'];
    const labels = docker([...args, '--filter', filter + project.name, '--format', 'x{{.Label \"credspan.deployment\"}}']);
    if (labels && labels.split('\n').some(value => value !== 'x' + project.deploymentId)) throw Error('Existing Compose resources belong to another deployment');
  }
}
function privateVolume(project, name) {
  const label = name === project.controlVolume ? 'credspan.control' : 'credspan.deployment';
  const value = name === project.controlVolume ? createHash('sha256').update(project.controlDirectory).digest('hex') : project.deploymentId;
  const existing = docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(name);
  if (existing) {
    const labels = JSON.parse(docker(['volume', 'inspect', name, '--format', '{{json .Labels}}']));
    if (labels?.[label] !== value) throw Error('Private volume belongs to another deployment');
  } else docker(['volume', 'create', '--label', 'credspan.private=true', '--label', label + '=' + value, name]);
}
const sqlLiteral = value => "'" + value.replaceAll("'", "''") + "'";
export async function secret(project, name) {
  const path = join(project.directory, 'secrets', name), info = await lstat(path);
  if (!info.isFile() || info.uid !== project.uid || info.mode & 0o077 || info.size > 4096) throw Error('Invalid private secret file');
  return (await readFile(path, 'utf8')).trimEnd();
}
export async function control(project, state, generation) {
  const path = join(project.controlDirectory, 'generation.json');
  const value = generation ?? JSON.parse(await readFile(path)).generation;
  if (!['active', 'fenced'].includes(state) || !/^[a-f0-9-]{36}$/.test(value)) throw Error('Invalid generation');
  const next = path + '.' + randomUUID(); await writeFile(next, JSON.stringify({ generation: value, state }) + '\n', { flag: 'wx', mode: 0o600 }); await rename(next, path);
  if (project.volumesReady) await syncPrivate(project, true);
  return value;
}
export function render(project) {
  const quoted = JSON.stringify;
  const files = ['admin_password', 'admin_pgpass', 'owner_pgpass'];
  const secretRefs = names => names.map(name => `      - ${name}`).join('\n');
  const env = user => `      CREDSPAN_SANDBOX: "1"\n      PUBLIC_URL: http://host.docker.internal:${project.port}\n      HOST: 0.0.0.0\n      PORT: "3000"\n      CONTROL_DIRECTORY: /run/control\n      MANAGEMENT_API_KEY_FILE: /run/secrets/management_key\n      ASKAR_STORE_ID: ${project.storeId}\n      ASKAR_STORE_KEY_FILE: /run/secrets/store_key\n      POSTGRES_HOST: postgres:5432\n      POSTGRES_USER: credspan_${user}\n      POSTGRES_PASSWORD_FILE: /run/secrets/${user}_password`;
  const restricted = `    user: "${project.uid}:${project.gid}"\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    tmpfs:\n      - /tmp:uid=${project.uid},gid=${project.gid},mode=0700,size=64m`;
  return `name: ${project.name}
services:
  postgres:
    image: ${images.postgres}
    environment:
      POSTGRES_USER: credspan_admin
      POSTGRES_PASSWORD_FILE: /run/secrets/admin_password
    secrets:
${secretRefs(['admin_password', 'admin_pgpass', 'owner_pgpass'])}
    volumes:
      - postgres:/var/lib/postgresql
    healthcheck:
      test: [CMD-SHELL, pg_isready -U credspan_admin]
      interval: 2s
      timeout: 2s
      retries: 30
  api:
    image: ${project.image}
    pull_policy: never
${restricted}
    environment:
${env('runtime')}
      CREDSPAN_TELEMETRY: "1"
    volumes:
      - runtime-secrets:/run/secrets:ro
      - control:/run/control:ro
    depends_on:
      postgres:
        condition: service_healthy
  maintenance:
    image: ${project.image}
    pull_policy: never
    profiles: [tools]
${restricted}
    environment:
${env('owner')}
    volumes:
      - maintenance-secrets:/run/secrets:ro
      - control:/run/control:ro
    command: [node, dist/src/maintenance.js, check]
  init:
    image: ${project.image}
    pull_policy: never
    profiles: [tools]
    user: "0:0"
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER]
    security_opt: [no-new-privileges:true]
    environment:
      TARGET_UID: "${project.uid}"
      TARGET_GID: "${project.gid}"
    volumes:
      - control:/init/control
      - runtime-secrets:/init/runtime
      - maintenance-secrets:/init/maintenance
    command: [node, /app/ops/init-volumes.mjs]
  edge:
    image: ${images.caddy}
${restricted}
    environment:
      XDG_DATA_HOME: /tmp/data
      XDG_CONFIG_HOME: /tmp/config
    ports:
      - 127.0.0.1:${project.port}:${project.port}
    volumes:
      - ${quoted(join(project.directory, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro')}
    networks:
      default:
        aliases: [host.docker.internal]
    depends_on: [api]
  wallet:
    image: ${project.walletImage}
    pull_policy: never
    profiles: [holder]
    ports:
      - 127.0.0.1::7006
    volumes:
      - ${quoted(join(project.directory, 'wallet-config') + ':/waltid-wallet-api2/config:ro')}
      - wallet:/waltid-wallet-api2/data
secrets:
${files.map(name => `  ${name}:\n    file: ${quoted(join(project.directory, 'secrets', name))}`).join('\n')}
volumes:
  postgres:
    labels: {credspan.deployment: ${project.deploymentId}}
  wallet:
    labels: {credspan.deployment: ${project.deploymentId}}
  control:
    external: true
    name: ${project.controlVolume}
  runtime-secrets:
    external: true
    name: ${project.runtimeVolume}
  maintenance-secrets:
    external: true
    name: ${project.maintenanceVolume}
networks:
  default:
    labels: {credspan.deployment: ${project.deploymentId}}
`.replace(/(services:[\s\S]*?)(?=^secrets:)/m, services => services.replace(/^  (postgres|api|maintenance|init|edge|wallet):\n/gm, match => match + `    labels: {credspan.deployment: ${project.deploymentId}}\n`));
}
export async function init(directory, { name = 'credspan-local', port = 8080, image, controlDirectory, deploymentId = randomUUID() } = {}) {
  const user = userInfo();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(deploymentId) || !/^credspan-[a-z0-9-]{1,31}$/.test(name) || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^sha256:[a-f0-9]{64}$/.test(image) || user.uid === 0) throw Error('Invalid local target');
  assertOwnership({ name, deploymentId: 'new-deployment-must-have-no-existing-resources' });
  directory = resolve(directory); await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  const walletImage = docker(['image', 'inspect', images.wallet, '--format', '{{.Id}}']);
  if (docker(['image', 'inspect', walletImage, '--format', '{{index .Config.Labels "credspan.probe.patch.sha256"}}']) !== 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa' || docker(['image', 'inspect', walletImage, '--format', '{{index .Config.Labels "credspan.dependencies.patch.sha256"}}']) !== '32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041') throw Error('Unqualified wallet peer');
  const project = { deploymentId, walletImage, version: 1, directory, name, port, image, uid: user.uid, gid: user.gid, controlDirectory: controlDirectory ? resolve(controlDirectory) : join(directory, 'control'), storeId: name.replaceAll('-', '_').slice(0, 40) };
  await mkdir(join(directory, 'secrets'), { mode: 0o700 });
  for (const name of ['admin_password', 'owner_password', 'runtime_password', 'management_key', 'store_key', 'backup_key']) await writeFile(join(directory, 'secrets', name), randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  for (const name of ['admin', 'owner']) await writeFile(join(directory, 'secrets', `${name}_pgpass`), `localhost:5432:*:credspan_${name}:${await secret(project, name + '_password')}\n`, { flag: 'wx', mode: 0o600 });
  if (!controlDirectory) { await mkdir(project.controlDirectory, { mode: 0o700 }); await control(project, 'fenced', randomUUID()); }
  const generation = JSON.parse(await readFile(join(project.controlDirectory, 'generation.json'))).generation;
  project.controlVolume = 'credspan_control_' + createHash('sha256').update(project.controlDirectory).digest('hex').slice(0, 16);
  project.runtimeVolume = project.name + '_runtime_' + generation.replaceAll('-', '');
  project.maintenanceVolume = project.name + '_maintenance_' + generation.replaceAll('-', '');
  project.volumesReady = false;
  await writeFile(join(directory, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'compose.yaml'), render(project), { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, 'Caddyfile'), `{\n  admin off\n  auto_https off\n  log {\n    output discard\n  }\n}\nhttp://host.docker.internal:${port}, http://localhost:${port}, http://127.0.0.1:${port} {\n  @allowed path /api/* /issuer/* /verifier/* /status-lists/* /.well-known/* /console /console/* /openapi.json /health/live\n  handle @allowed {\n    reverse_proxy api:3000\n  }\n  respond 404\n}\nhttp://:${port} {\n  respond 421\n}\n`, { flag: 'wx', mode: 0o600 });
  await mkdir(join(directory, 'wallet-config'), { mode: 0o700 });
  for (const [name, value] of Object.entries({ '_features.conf': 'enabledFeatures = [wallet2-persistence]\ndisabledFeatures = []\n', 'web.conf': 'webHost = "0.0.0.0"\nwebPort = 7006\n', 'wallet2-persistence.conf': 'jdbcUrl = "jdbc:sqlite:data/wallet2.db"\ndriverClassName = "org.sqlite.JDBC"\n', 'wallet-service.conf': 'publicBaseUrl = "http://localhost:7006"\n', 'network-fetch-guard.conf': 'allowLoopback = false\nallowPrivateNetworks = false\ntrustedHostSuffixes = ["host.docker.internal"]\n' })) await writeFile(join(directory, 'wallet-config', name), value, { mode: 0o600 });
  for (const volume of [project.controlVolume, project.runtimeVolume, project.maintenanceVolume]) privateVolume(project, volume);
  project.volumesReady = true;
  await writeFile(join(directory, 'project.json'), JSON.stringify(project, null, 2) + '\n', { mode: 0o600 });
  await syncPrivate(project);
  return project;
}
export async function syncPrivate(project, controlOnly = false) {
  const data = { control: JSON.parse(await readFile(join(project.controlDirectory, 'generation.json'))), lock: null, secrets: {} };
  try { data.lock = JSON.parse(await readFile(join(project.controlDirectory, 'maintenance.lock'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!controlOnly) {
    for (const name of ['management_key', 'store_key', 'runtime_password', 'owner_password']) data.secrets[name] = await secret(project, name);
    try { data.secrets.new_store_key = await secret(project, 'new_store_key'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Stdin avoids host bind ownership and atomic-rename visibility differences on Docker Desktop.
  return compose(project, ['run', '--rm', '--no-deps', '-T', 'init', 'node', '/app/ops/init-volumes.mjs', ...(controlOnly ? ['control-only'] : [])], { input: JSON.stringify(data) });
}
export async function load(directory) {
  const folder = await lstat(resolve(directory)), marker = await lstat(join(resolve(directory), 'project.json'));
  if (!folder.isDirectory() || folder.uid !== userInfo().uid || folder.mode & 0o077 || !marker.isFile() || marker.uid !== userInfo().uid || marker.mode & 0o077 || marker.size > 8192) throw Error('Invalid private project directory');
  const project = JSON.parse(await readFile(join(resolve(directory), 'project.json')));
  if (project.version !== 1 || !/^[a-f0-9-]{36}$/.test(project.deploymentId) || project.directory !== resolve(directory) || !/^credspan-[a-z0-9-]+$/.test(project.name) || !/^sha256:[a-f0-9]{64}$/.test(project.image) || project.uid !== userInfo().uid || project.uid === 0 || !/^[a-z][a-z0-9_]{0,40}$/.test(project.storeId)) throw Error('Invalid project marker');
  if (!Number.isInteger(project.port) || project.port < 1024 || project.port > 65535 || project.gid !== userInfo().gid || !/^sha256:[a-f0-9]{64}$/.test(project.walletImage) || ![project.controlVolume, project.runtimeVolume, project.maintenanceVolume].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value))) throw Error('Invalid project resources');
  const controlInfo = await lstat(project.controlDirectory); if (!controlInfo.isDirectory() || controlInfo.uid !== project.uid || controlInfo.mode & 0o077) throw Error('Invalid control directory');
  for (const name of ['admin_password', 'owner_password', 'runtime_password', 'management_key', 'store_key', 'backup_key']) await secret(project, name);
  assertOwnership(project);
  return project;
}
export function psql(project, sql, database = 'postgres', owner = false) {
  return compose(project, ['exec', '-T', '--user', 'root', '-e', `PGPASSFILE=/run/secrets/${owner ? 'owner' : 'admin'}_pgpass`, 'postgres', 'psql', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '-h', 'localhost', '-U', `credspan_${owner ? 'owner' : 'admin'}`, '-d', database], { input: sql });
}
export async function roles(project) {
  const owner = await secret(project, 'owner_password'), runtime = await secret(project, 'runtime_password');
  psql(project, `DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='credspan_owner') THEN CREATE ROLE credspan_owner LOGIN NOINHERIT CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD ${sqlLiteral(owner)}; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='credspan_runtime') THEN CREATE ROLE credspan_runtime LOGIN NOINHERIT NOCREATEDB NOSUPERUSER NOCREATEROLE PASSWORD ${sqlLiteral(runtime)}; END IF; END$$;`);
}
export async function grants(project) {
  psql(project, `ALTER ROLE credspan_runtime IN DATABASE "${project.storeId}" SET search_path=credspan_owner;`);
  const tables = psql(project, "SELECT tablename FROM pg_tables WHERE schemaname='credspan_owner' ORDER BY tablename;", project.storeId);
  if (!['config', 'items', 'items_tags', 'profiles'].every(name => tables.includes(name))) throw Error('Unexpected native schema; review grants');
  psql(project, `REVOKE ALL ON DATABASE "${project.storeId}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${project.storeId}" TO credspan_runtime; REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE ALL ON SCHEMA credspan_owner FROM PUBLIC; GRANT USAGE ON SCHEMA credspan_owner TO credspan_runtime; GRANT SELECT ON credspan_owner.config,credspan_owner.profiles TO credspan_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON credspan_owner.items,credspan_owner.items_tags TO credspan_runtime; GRANT USAGE,SELECT ON SEQUENCE credspan_owner.profiles_id_seq,credspan_owner.items_id_seq,credspan_owner.items_tags_id_seq TO credspan_runtime;`, project.storeId, true);
}
export function maintenance(project, operation, previousGeneration, operationId, extra = []) {
  return compose(project, ['run', '--rm', '--no-deps', '-e', `PREVIOUS_GENERATION=${previousGeneration ?? ''}`, '-e', `MAINTENANCE_OPERATION_ID=${operationId ?? ''}`, ...extra, 'maintenance', 'node', 'dist/src/maintenance.js', operation, '--apply']);
}
export async function withLock(project, operation, action) {
  const path = join(project.controlDirectory, 'maintenance.lock'), operationId = randomUUID();
  await writeFile(path, JSON.stringify({ operationId, operation }), { flag: 'wx', mode: 0o600 });
  await syncPrivate(project, true);
  try { return await action(operationId); } finally { const held = JSON.parse(await readFile(path)); if (held.operationId !== operationId) throw Error('Maintenance lock ownership changed'); await unlink(path); await syncPrivate(project, true); }
}
export async function provision(project) {
  return withLock(project, 'provision', async operationId => {
    startPostgres(project); await roles(project);
    maintenance(project, 'provision', undefined, operationId); await grants(project); await control(project, 'active');
  });
}
export async function quiesce(project) {
  const other = psql(project, `SELECT count(*) FROM pg_stat_activity WHERE usename='credspan_runtime' AND datname <> '${project.storeId}' AND backend_type='client backend';`).trim();
  if (other !== '0') throw Error('Runtime role is in use outside the intended store');
  psql(project, `ALTER ROLE credspan_runtime NOLOGIN; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='credspan_runtime' AND datname='${project.storeId}' AND pid <> pg_backend_pid();`);
  const password = randomBytes(32).toString('hex');
  psql(project, `ALTER ROLE credspan_runtime PASSWORD ${sqlLiteral(password)};`);
  const path = join(project.directory, 'secrets', 'runtime_password'), next = path + '.' + randomUUID();
  await writeFile(next, password + '\n', { mode: 0o600, flag: 'wx' }); await rename(next, path);
}
export async function rotate(project, operation, keyFile) {
  if (!['retire', 'rekey', 'upgrade'].includes(operation)) throw Error('Invalid rotation');
  return withLock(project, operation, async operationId => {
    const current = JSON.parse(await readFile(join(project.controlDirectory, 'generation.json')));
    if (current.state !== 'active' && !(operation === 'upgrade' && current.state === 'fenced')) throw Error('Incomplete maintenance requires operator recovery');
    const generation = await control(project, 'fenced', randomUUID());
    await quiesce(project); compose(project, ['stop', 'api', 'edge']);
    const extra = [];
    project.runtimeVolume = project.name + '_runtime_' + generation.replaceAll('-', '');
    project.maintenanceVolume = project.name + '_maintenance_' + generation.replaceAll('-', '');
    for (const volume of [project.runtimeVolume, project.maintenanceVolume]) privateVolume(project, volume);
    await writeFile(join(project.directory, 'project.json'), JSON.stringify(project, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(project.directory, 'compose.yaml'), render(project), { mode: 0o600 });
    if (operation === 'rekey') {
      const info = await lstat(keyFile); if (!info.isFile() || info.uid !== project.uid || info.mode & 0o077 || info.size > 4096) throw Error('Invalid new store secret');
      await writeFile(join(project.directory, 'secrets', 'new_store_key'), await readFile(keyFile), { mode: 0o600, flag: 'wx' });
      extra.push('-e', 'NEW_STORE_KEY_FILE=/run/secrets/new_store_key');
    }
    await syncPrivate(project);
    maintenance(project, operation, operation === 'upgrade' ? 'legacy' : current.generation, operationId, extra);
    if (operation === 'rekey') {
      const path = join(project.directory, 'secrets', 'store_key'), next = path + '.' + randomUUID();
      await writeFile(join(project.directory, 'secrets', 'rollback_store_key_' + current.generation), await readFile(path), { mode: 0o600, flag: 'wx' });
      await writeFile(next, await readFile(keyFile), { mode: 0o600, flag: 'wx' }); await rename(next, path);
    }
    if (operation === 'rekey') await unlink(join(project.directory, 'secrets', 'new_store_key'));
    await syncPrivate(project);
    psql(project, 'ALTER ROLE credspan_runtime LOGIN;');
    await control(project, 'active', generation);
    compose(project, ['up', '-d', '--wait', '--force-recreate', 'api', 'edge']);
  });
}
export async function backup(project, destination) {
  const args = ['compose', '--project-name', project.name, '--file', join(project.directory, 'compose.yaml'), 'exec', '-T', '--user', 'root', '-e', 'PGPASSFILE=/run/secrets/owner_pgpass', 'postgres', 'pg_dump', '-Fc', '-h', 'localhost', '-U', 'credspan_owner', project.storeId];
  const boundary = dockerBoundary();
  const child = spawn('docker', [...boundary.prefix, ...args], { env: boundary.env, stdio: ['ignore', 'pipe', 'ignore'] });
  await encryptProcessBackup(child, Buffer.from(await secret(project, 'backup_key'), 'hex'), destination);
}
async function backupKey(project, keyFile) {
  const info = await lstat(keyFile);
  if (!info.isFile() || info.uid !== project.uid || info.size > 4096 || info.mode & 0o077) throw Error('Backup key file must be private');
  const value = (await readFile(keyFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw Error('Invalid backup key');
  return Buffer.from(value, 'hex');
}
async function restoreVerified(project, verified) {
  // Target must not exist. Never overwrite an existing database implicitly.
  psql(project, `CREATE DATABASE "${project.storeId}" OWNER credspan_owner;`);
  const boundary = dockerBoundary();
  const child = spawn('docker', [...boundary.prefix, 'compose', '--project-name', project.name, '--file', join(project.directory, 'compose.yaml'), 'exec', '-T', '--user', 'root', '-e', 'PGPASSFILE=/run/secrets/owner_pgpass', 'postgres', 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl', '-h', 'localhost', '-U', 'credspan_owner', '-d', project.storeId], { env: boundary.env, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error('Database restore failed'))); child.stdin.on('error', reject); createReadStream(verified).on('error', reject).pipe(child.stdin); });
  await grants(project);
}
export async function restore(project, source, keyFile) {
  await withVerifiedBackup(source, await backupKey(project, keyFile), verified => restoreVerified(project, verified));
}
export async function recover(project, source, keyFile, previousGeneration) {
  if (!/^[a-f0-9-]{36}$/.test(previousGeneration)) throw Error('Expected backup generation required');
  // Full authentication precedes all database changes, including role/session changes.
  await withVerifiedBackup(source, await backupKey(project, keyFile), verified => withLock(project, 'retire', async operationId => {
    const generation = await control(project, 'fenced', randomUUID());
    startPostgres(project); await roles(project);
    await quiesce(project); compose(project, ['stop', 'api', 'edge']);
    await restoreVerified(project, verified);
    project.runtimeVolume = project.name + '_runtime_' + generation.replaceAll('-', '');
    project.maintenanceVolume = project.name + '_maintenance_' + generation.replaceAll('-', '');
    for (const volume of [project.runtimeVolume, project.maintenanceVolume]) privateVolume(project, volume);
    await writeFile(join(project.directory, 'project.json'), JSON.stringify(project, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(project.directory, 'compose.yaml'), render(project), { mode: 0o600 });
    await syncPrivate(project);
    maintenance(project, 'retire', previousGeneration, operationId);
    psql(project, 'ALTER ROLE credspan_runtime LOGIN;');
    await control(project, 'active', generation);
    compose(project, ['up', '-d', '--wait', '--force-recreate', 'api', 'edge']);
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation = 'check', directory = './ops/local-state', ...arguments_] = process.argv.slice(2);
    const apply = arguments_.includes('--apply'), values = arguments_.filter(value => value !== '--apply');
    const arity = { check: 0, render: 0, init: 0, provision: 0, up: 0, down: 0, retire: 0, upgrade: 0, fence: 0, backup: 1, rekey: 1, recover: 3 };
    if (!(operation in arity) || values.length !== arity[operation] || values.some(value => value.startsWith('--'))) throw Error('Unknown operation or arguments');
    if (!apply && !['check', 'render'].includes(operation)) console.log(JSON.stringify({ plan: operation, directory: resolve(directory), apply: false }));
    else if (operation === 'init') { const project = await init(directory, { image: docker(['image', 'inspect', 'credspan-api:local', '--format', '{{.Id}}']) }); console.log(JSON.stringify({ initialized: true, project: project.name })); }
    else {
      const project = await load(directory);
      if (operation === 'render') console.log(render(project));
      else if (operation === 'check') { compose(project, ['config', '--quiet']); console.log(JSON.stringify({ valid: true, project: project.name, image: project.image, ports: 'edge-loopback-only' })); }
      else if (operation === 'provision') { await provision(project); console.log('Local native store provisioned; runtime has no owner credentials.'); }
      else if (operation === 'up') await withLock(project, 'start', async () => { compose(project, ['up', '-d', '--wait', 'api', 'edge']); console.log(`Local console: http://127.0.0.1:${project.port}/console/`); });
      else if (operation === 'down') await withLock(project, 'stop', async () => { down(project); console.log('Local services stopped; volumes retained.'); });
      else if (operation === 'fence') await withLock(project, 'fence', async () => { await control(project, 'fenced', randomUUID()); await quiesce(project); compose(project, ['stop', 'api', 'edge']); console.log('Deployment fenced; runtime credentials invalidated; services stopped.'); });
      else if (operation === 'backup') await withLock(project, 'backup', () => backup(project, resolve(values[0])));
      else if (operation === 'recover') await recover(project, resolve(values[0]), resolve(values[1]), values[2]);
      else { await rotate(project, operation, values[0] && resolve(values[0])); console.log(operation !== 'rekey' ? 'Cohort retired or explicitly upgraded; reissue credentials.' : 'Store secret changed; signer and cohort retained.'); }
    }
  } catch { console.error('Local operation failed closed. Check private project files, control state, native schema and service readiness.'); process.exitCode = 1; }
}
