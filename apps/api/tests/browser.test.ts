import { provision } from './provision.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Ajv } from 'ajv';
import { createRequire } from 'node:module';
const addFormats = createRequire(import.meta.url)('ajv-formats') as (ajv: Ajv) => void;
import { createClient, createIssuance, getIssuanceStatus, getPresentationResult } from '@credspan/sdk';
import { createApplication } from '../src/app.js';
import { readConfig } from '../src/config.js';
const exec = promisify(execFile);
async function docker(...args: string[]) { return (await exec('docker', args, { maxBuffer: 2_000_000 })).stdout.trim(); }
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
async function waitFor(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { try { if (await check()) return; } catch {} await delay(200); } throw Error('Readiness timed out'); }

test('hosted console sends its HttpOnly Access cookie with the management bearer', { timeout: 30_000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = 'https://credspan-sandbox.m1ngshum.com', key = 'synthetic-management-key-'.repeat(2);
    const context = await browser.newContext();
    await context.addCookies([{ name: 'CF_Authorization', value: 'synthetic-access-session', domain: 'credspan-sandbox.m1ngshum.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    let headers: Record<string, string> | undefined;
    await context.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/issuance-sessions') {
        headers = await route.request().allHeaders();
        await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
      } else if (path.startsWith('/console/')) {
        await route.fulfill({ path: new URL('../../../console/dist/' + (path.slice('/console/'.length) || 'index.html'), import.meta.url).pathname });
      } else await route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin + '/console/');
    assert.equal(await page.evaluate(() => document.cookie), '', 'Access session remains HttpOnly');
    await page.getByLabel('Management key').fill(key); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Display name').fill('Synthetic browser'); await page.getByLabel('Member ID').fill('synthetic-browser');
    await page.getByRole('button', { name: 'Create offer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    assert.equal(headers?.cookie, 'CF_Authorization=synthetic-access-session');
    assert.equal(headers?.authorization, 'Bearer ' + key);
    assert.equal(headers?.['cf-access-client-id'], undefined); assert.equal(headers?.['cf-access-client-secret'], undefined);
  } finally { await browser.close(); }
});

test('real browser, generated SDK and independent wallet use unchanged configured URLs', { timeout: 180_000 }, async t => {
  const label = `credspan-probe-browser-${randomBytes(4).toString('hex')}`, directory = await mkdtemp(join(tmpdir(), 'credspan-browser-'));
  const apiPort = await freePort(), origin = `http://127.0.0.1:${apiPort}`, key = randomBytes(32).toString('hex'), password = randomBytes(24).toString('hex');
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    await writeFile(join(directory, '_features.conf'), 'enabledFeatures = [wallet2-persistence]\ndisabledFeatures = []\n');
    await writeFile(join(directory, 'web.conf'), 'webHost = "0.0.0.0"\nwebPort = 7006\n');
    await writeFile(join(directory, 'wallet2-persistence.conf'), 'jdbcUrl = "jdbc:sqlite:data/wallet2.db"\ndriverClassName = "org.sqlite.JDBC"\n');
    await writeFile(join(directory, 'wallet-service.conf'), 'publicBaseUrl = "http://localhost:7006"\n');
    await writeFile(join(directory, 'network-fetch-guard.conf'), 'allowLoopback = false\nallowPrivateNetworks = false\ntrustedHostSuffixes = ["host.docker.internal"]\n');
    await docker('run', '-d', '--name', `${label}-pg`, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_USER=credspan', 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42');
    await waitFor(async () => (await docker('exec', `${label}-pg`, 'pg_isready', '-U', 'credspan')).includes('accepting'));
    const pgPort = (await docker('port', `${label}-pg`, '5432/tcp')).split(':').at(-1)!;
    const image = process.env.WALLET_IMAGE ?? 'credspan-wallet-peer:1.2.1-preauth';
    assert.equal(await docker('image', 'inspect', image, '--format', '{{index .Config.Labels "credspan.probe.patch.sha256"}}'), 'ed059fd9f91f8b371c2c35839ed5a350185ebea16d346054d286db83e05e73aa');
    assert.equal(await docker('image', 'inspect', image, '--format', '{{index .Config.Labels "credspan.dependencies.patch.sha256"}}'), '32cb0096a32693e17674038caa316605822c4b879e9cf5fad41008ea50b33041');
    await docker('run', '-d', '--name', `${label}-wallet`, '-p', '127.0.0.1::7006', '--add-host', 'host.docker.internal:host-gateway', '--mount', `type=bind,source=${directory},target=/waltid-wallet-api2/config,readonly`, image);
    const walletOrigin = `http://127.0.0.1:${(await docker('port', `${label}-wallet`, '7006/tcp')).split(':').at(-1)!}`;
    await waitFor(async () => (await fetch(walletOrigin + '/livez')).ok);
    const walletPost = async (path: string, body: unknown) => { const response = await fetch(walletOrigin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok, `Wallet endpoint returned ${response.status}`); return await response.json(); };
    const config = readConfig({ CONTROL_DIRECTORY: directory, CREDSPAN_SANDBOX: '1', PUBLIC_URL: `http://host.docker.internal:${apiPort}`, HOST: '0.0.0.0', PORT: String(apiPort), MANAGEMENT_API_KEY: key, ASKAR_STORE_ID: 'credspan_browser', ASKAR_STORE_KEY: randomBytes(32).toString('hex'), POSTGRES_HOST: `127.0.0.1:${pgPort}`, POSTGRES_USER: 'credspan', POSTGRES_PASSWORD: password });
    await provision(config); application = await createApplication(config);
    const pnpm = process.env.npm_execpath; assert.ok(pnpm, 'Run through pnpm test:browser');
    const diagnosisOptions = { cwd: new URL('../../../../', import.meta.url), env: { ...process.env, CREDSPAN_API_URL: origin } };
    await assert.rejects(exec(pnpm, ['run', 'doctor'], diagnosisOptions), { code: 1, stdout: /Local API: unavailable/ });
    await application.app.listen(apiPort, '0.0.0.0');
    const spec = JSON.parse(await readFile(new URL('../../../../packages/sdk/openapi.json', import.meta.url), 'utf8'));
    assert.deepEqual(await (await fetch(origin + '/openapi.json')).json(), spec, 'Runtime and checked-in management contract agree');
    const ajv = new Ajv({ strict: false }); addFormats(ajv);
    const validateResponse = async (path: string, method: string, response: Response) => {
      const schema = spec.paths[path][method].responses[response.status]?.content?.['application/json']?.schema;
      assert.ok(schema, `Documented ${method} ${path} status ${response.status}`);
      const validate = ajv.compile(schema); assert.ok(validate(await response.json()), JSON.stringify(validate.errors));
    };
    await t.test('real runtime input bounds and generated SDK responses match the contract', async () => {
      const validInput = ajv.compile(spec.paths['/api/issuance-sessions'].post.requestBody.content['application/json'].schema);
      const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      for (const body of [{ name: '\u0000', memberId: 'a' }, { name: ' '.repeat(2), memberId: 'a' }, { name: 'x'.repeat(101), memberId: 'a' }, { name: '🙂'.repeat(101), memberId: 'a' }, { name: 'x', memberId: '../a' }, { name: 'x', memberId: 'a', extra: true }, []]) {
        assert.equal(validInput(body), false, 'The OpenAPI request schema rejects the same invalid input');
        const response = await fetch(origin + '/api/issuance-sessions', { method: 'POST', headers: auth, body: JSON.stringify(body) }); assert.equal(response.status, 400); await validateResponse('/api/issuance-sessions', 'post', response);
      }
      const denied = await fetch(origin + '/api/issuance-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(denied.status, 401); await validateResponse('/api/issuance-sessions', 'post', denied);
      const client = createClient({ baseUrl: origin, auth: key, redirect: 'error' });
      for (const name of ['x'.repeat(100), '🙂'.repeat(100), '\u2028Synthetic', '\u2029Synthetic']) {
        assert.equal(validInput({ name, memberId: 'contract-test' }), true);
        const issued = await createIssuance({ client, body: { name, memberId: 'contract-test' } }); assert.equal(issued.response?.status, 201); assert.ok(issued.data); await validateResponse('/api/issuance-sessions', 'post', new Response(JSON.stringify(issued.data), { status: 201 }));
        const status = await getIssuanceStatus({ client, path: { id: issued.data.id } }); assert.equal(status.response?.status, 200); await validateResponse('/api/issuance-sessions/{id}', 'get', new Response(JSON.stringify(status.data), { status: 200 }));
      }
      const invalid = await fetch(origin + '/api/presentation-requests', { method: 'POST', headers: auth, body: '{"extra":true}' }); assert.equal(invalid.status, 400); await validateResponse('/api/presentation-requests', 'post', invalid);
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date() });
    await page.goto(origin + '/console/');
    await expect(page.getByRole('link', { name: 'Credspan Open credentials. Built to run.' })).toBeVisible();
    const brandImage = page.getByRole('img', { name: 'Credspan', exact: true });
    await expect(brandImage).toHaveJSProperty('complete', true);
    assert.ok(await brandImage.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0));
    for (const selector of ['link[rel="icon"][type="image/svg+xml"]', 'link[rel="apple-touch-icon"]', 'link[rel="manifest"]']) {
      const assetUrl = new URL((await page.locator(selector).getAttribute('href'))!, page.url());
      assert.equal(assetUrl.origin, origin); assert.ok(assetUrl.pathname.startsWith('/console/'));
      const response = await fetch(assetUrl); assert.equal(response.status, 200);
      if (selector.includes('manifest')) {
        const manifest = await response.json();
        for (const icon of manifest.icons) assert.equal((await fetch(new URL(icon.src, assetUrl))).status, 200);
      }
    }
    const headers = await fetch(origin + '/console/'); assert.match(headers.headers.get('content-security-policy')!, /connect-src 'self'/); assert.match(headers.headers.get('content-security-policy')!, /manifest-src 'self'/);
    await expect(page.getByRole('heading', { name: 'Your data. Your proof. Your choice.' })).toBeVisible();
    await expect(page.locator('label[for=management-key]')).toBeVisible();
    await page.getByLabel('Management key').fill('invalid-but-sufficiently-long-management-key'); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Display name').fill('Synthetic Browser'); await page.getByLabel('Member ID', { exact: true }).fill('browser-member'); await page.getByRole('button', { name: 'Create offer' }).click();
    await expect(page.locator('.notice[role=status]')).toContainText('Key rejected');
    await page.getByLabel('Management key').fill(key); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('Display name').fill('a'.repeat(101)); await page.getByLabel('Member ID', { exact: true }).fill('browser-member');
    await page.getByRole('button', { name: 'Create offer' }).click();
    await expect(page.getByLabel('Display name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert')).toContainText('100 Unicode code points');
    await expect(page.getByLabel('Display name')).toBeFocused();
    let issuancePosts = 0;
    await page.route('**/api/issuance-sessions', async route => {
      if (route.request().method() === 'POST') issuancePosts++;
      await delay(250); await route.continue();
    });
    await page.getByLabel('Display name').fill('😀'.repeat(100));
    await expect(page.getByLabel('Display name')).toHaveAttribute('aria-invalid', 'false');
    const memberId = page.getByLabel('Member ID', { exact: true });
    await expect(memberId).toHaveAttribute('maxlength', '64');
    for (const value of ['bad space', '!']) {
      await memberId.fill(value);
      assert.equal(await memberId.evaluate((input: HTMLInputElement) => input.checkValidity()), false);
      await page.getByRole('button', { name: 'Create offer' }).click();
      await expect(memberId).toBeFocused();
      assert.equal(issuancePosts, 0);
    }
    for (const value of ['normal-01', 'normal-01._'.padEnd(64, 'a')]) {
      await memberId.fill(value);
      await expect(memberId).toHaveValue(value);
      assert.equal(await memberId.evaluate((input: HTMLInputElement) => input.checkValidity()), true);
    }
    await page.getByRole('button', { name: 'Create offer' }).click();
    await expect(page.getByRole('button', { name: 'Creating offer…' })).toBeVisible();
    await expect(page.locator('.card').first()).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('textbox', { name: 'Credential offer', exact: true })).toBeVisible();
    assert.equal(issuancePosts, 1);
    const offer = await page.getByRole('textbox', { name: 'Credential offer', exact: true }).inputValue();
    const credentialId = page.getByText('Credential ID', { exact: true }).locator('xpath=following-sibling::dd[1]');
    const originalCredentialId = await credentialId.innerText();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('synthetic-denial'); } } }); });
    await page.getByRole('button', { name: 'Copy credential offer', exact: true }).click();
    await expect(page.getByText('Could not copy. Select the URL and copy it manually.')).toBeVisible();
    assert.equal(await page.getByRole('textbox', { name: 'Credential offer', exact: true }).inputValue(), offer);
    assert.equal(new URL(new URL(offer).searchParams.get('credential_offer_uri')!).hostname, 'host.docker.internal');
    const { walletId } = await walletPost('/wallet', {}); const { keyId } = await walletPost(`/wallet/${walletId}/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
    assert.equal((await walletPost(`/wallet/${walletId}/credentials/receive`, { offerUrl: offer, keyId })).credentialIds.length, 1);
    await page.getByRole('button', { name: 'Check issuance status' }).click(); await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/presentation-requests' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create request', exact: true }).click();
    const presentationId = (await (await creating).json()).id;
    const sdk = createClient({ baseUrl: origin, auth: key, redirect: 'error' });
    const pending = await getPresentationResult({ client: sdk, path: { id: presentationId } }); assert.equal(pending.data?.accepted, false);
    await validateResponse('/api/presentation-requests/{id}/result', 'get', new Response(JSON.stringify(pending.data), { status: 200 }));
    const requestBox = page.getByRole('textbox', { name: 'Presentation request', exact: true }); await expect(requestBox).toBeVisible();
    const request = await requestBox.inputValue(); assert.equal(new URL(new URL(request).searchParams.get('request_uri')!).hostname, 'host.docker.internal');
    assert.equal((await walletPost(`/wallet/${walletId}/credentials/present`, { requestUrl: request })).transmission_success, true);
    await page.getByRole('button', { name: 'Check presentation result' }).click(); await expect(page.getByRole('heading', { name: 'Accepted at last check' })).toBeVisible();
    await page.clock.fastForward(360_000);
    await expect(page.getByRole('heading', { name: 'Not accepted', exact: true })).toBeVisible();
    await page.clock.setSystemTime(new Date()); await page.clock.runFor(1000);
    await page.getByRole('button', { name: 'Check presentation result' }).click(); await expect(page.getByRole('heading', { name: 'Accepted at last check' })).toBeVisible();
    const accepted = await getPresentationResult({ client: sdk, path: { id: presentationId } }); assert.ok(accepted.data?.accepted);
    await validateResponse('/api/presentation-requests/{id}/result', 'get', new Response(JSON.stringify(accepted.data), { status: 200 }));
    const receipt = await application.runtime.agent.genericRecords.findById(`credspan:verification-receipt:${presentationId}`); assert.ok(receipt);
    const originalReceipt = { ...receipt.content };
    for (const patch of [{ authorizationExpiresAt: 'invalid' }, { verifiedAt: 'invalid' }, { authorizationExpiresAt: new Date(Date.now() + 9999999).toISOString() }]) {
      receipt.content = { ...originalReceipt, ...patch }; await application.runtime.agent.genericRecords.update(receipt);
      const corrupted = await fetch(`${origin}/api/presentation-requests/${presentationId}/result`, { headers: { authorization: `Bearer ${key}` } }); assert.equal(corrupted.status, 503); await validateResponse('/api/presentation-requests/{id}/result', 'get', corrupted);
    }
    receipt.content = originalReceipt; await application.runtime.agent.genericRecords.update(receipt);
    const accessibility = await new AxeBuilder({ page }).analyze(); assert.deepEqual(accessibility.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target), reasons: violation.nodes.map(node => node.failureSummary) })), []);
    const screenshots = process.env.CREDSPAN_SCREENSHOTS;
    if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'console-desktop.png'), fullPage: true, mask: [page.locator('textarea'), page.locator('input[type=password]')] }); }
    // Only the first replacement attempt is simulated. Revocation and retry use the real API.
    await page.route('**/api/issuance-sessions', route => route.fulfill({ status: 503, json: { message: 'Synthetic unavailable response' } }), { times: 1 });
    await page.getByLabel('Display name').fill('Replacement member');
    await memberId.fill('replacement-member');
    const createOffer = page.getByRole('button', { name: 'Create offer', exact: true });
    await createOffer.click();
    await expect(page.getByRole('status').filter({ hasText: 'Request failed (503)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accepted at last check' })).toHaveCount(0);
    await expect(page.getByText('Last successful offer', { exact: true })).toBeVisible();
    await expect(credentialId).toHaveText(originalCredentialId);
    assert.ok(await page.getByRole('textbox', { name: 'Credential offer', exact: true }).inputValue() === offer);
    await page.getByRole('button', { name: 'Revoke issued credential', exact: true }).click();
    await expect(page.locator('.confirm')).toContainText(originalCredentialId);
    await page.getByRole('button', { name: 'Confirm revocation' }).click();
    await expect(page.getByRole('heading', { name: 'Credential revoked', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^Credential revoked\.$/ })).toBeVisible();
    const rejected = await getPresentationResult({ client: sdk, path: { id: presentationId } }); assert.equal(rejected.data?.accepted, false); await validateResponse('/api/presentation-requests/{id}/result', 'get', new Response(JSON.stringify(rejected.data), { status: 200 }));
    assert.equal(rejected.data && 'verifiedAt' in rejected.data ? rejected.data.verifiedAt : undefined, accepted.data.verifiedAt, 'Historical proof timestamp does not change on revocation');
    const postsBeforeRetry = issuancePosts;
    await createOffer.click();
    await expect(page.getByRole('status').filter({ hasText: 'Offer created.' })).toBeVisible();
    assert.equal(issuancePosts, postsBeforeRetry + 1);
    await expect(credentialId).not.toHaveText(originalCredentialId);
    await expect(credentialId).toHaveCount(1);
    await expect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revoke issued credential', exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0);
    assert.equal(await page.evaluate(secret => document.documentElement.outerHTML.includes(secret), key), false); assert.equal((await page.context().cookies()).length, 0); assert.ok(!page.url().includes(key));
    await page.getByRole('button', { name: 'Disconnect' }).click(); await expect(page.getByLabel('Management key')).toHaveValue(''); await expect(page.locator('textarea')).toHaveCount(0);
    await expect(credentialId).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(violation => violation.id), []);
    await page.getByLabel('Management key').focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeFocused();
    if (screenshots) await page.screenshot({ path: join(screenshots, 'console-mobile.png'), fullPage: true });
    // Separate UI race control, not interoperability evidence: only the delayed old response is simulated.
    for (const lateStatus of [200, 401]) {
      let release!: () => void, reached!: () => void;
      const pause = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { reached = resolve; });
      let firstRequest = true;
      await page.route('**/api/issuance-sessions', async route => {
        if (!firstRequest) { await route.continue(); return; }
        firstRequest = false; reached(); await pause;
        await route.fulfill({ status: lateStatus, contentType: 'application/json', body: lateStatus === 401 ? JSON.stringify({ error: 'unauthorized' }) : JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', credentialId: 'urn:uuid:00000000-0000-4000-8000-000000000000', expiresAt: new Date(Date.now() + 3600000).toISOString(), offer: 'synthetic-old-capability' }) }).catch(() => {});
      });
      await page.getByLabel('Management key').fill(key); await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByLabel('Display name').fill('Old session'); await page.getByLabel('Member ID', { exact: true }).fill('old-session'); await page.getByRole('button', { name: 'Create offer' }).click(); await started;
      await page.getByRole('button', { name: 'Disconnect' }).click();
      await page.getByLabel('Management key').fill(key); await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByLabel('Display name').fill('New session'); await page.getByLabel('Member ID', { exact: true }).fill('new-session'); await page.getByRole('button', { name: 'Create offer' }).click();
      await expect(page.getByRole('textbox', { name: 'Credential offer', exact: true })).toBeVisible();
      const newest = await page.getByRole('textbox', { name: 'Credential offer', exact: true }).inputValue();
      release(); await page.waitForTimeout(100);
      await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
      assert.ok((await page.getByRole('textbox', { name: 'Credential offer', exact: true }).inputValue()) === newest, 'Late old response cannot replace new session');
      await page.unroute('**/api/issuance-sessions'); await page.getByRole('button', { name: 'Disconnect' }).click();
    }
    assert.deepEqual(errors, []);
    await page.close();
    const example = await exec(process.execPath, [new URL('../../../../examples/membership.mjs', import.meta.url).pathname], { env: { ...process.env, MANAGEMENT_API_KEY: key, CREDSPAN_API_URL: origin, CREDSPAN_WALLET_URL: walletOrigin } });
    const diagnosis = await exec(pnpm, ['run', 'doctor'], diagnosisOptions); assert.ok(diagnosis.stdout.includes('management contract reachable'));
    const exampleResult = JSON.parse(example.stdout); assert.equal(exampleResult.acceptedBeforeRevocation, true); assert.equal(exampleResult.acceptedAfterRevocation, false);
  } finally {
    await browser.close(); if (application) await application.close();
    await docker('rm', '-f', '-v', `${label}-wallet`, `${label}-pg`).catch(() => {}); await rm(directory, { recursive: true, force: true });
  }
});
