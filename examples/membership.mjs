import { createClient, createIssuance, getIssuanceStatus, createPresentation, getPresentationResult, revokeCredential } from '../packages/sdk/dist/index.js';
import { connection } from './connection.mjs';
try {
  const { api, wallet, key, request } = connection();
  const client = createClient({ baseUrl: api, auth: key, fetch: request, redirect: 'error', credentials: 'omit' });
  const data = result => { if (!result.response?.ok || !result.data) throw Error('API rejected request'); return result.data; };
  const walletPost = async (path, body) => { const response = await request(wallet + path, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw Error('Wallet rejected request'); return await response.json(); };
  const issued = data(await createIssuance({ client, body: { name: 'Synthetic Example', memberId: 'example-member' } }));
  const { walletId } = await walletPost('/wallet', {});
  const { keyId } = await walletPost(`/wallet/${walletId}/keys/generate`, { backend: 'jwk', keyType: 'secp256r1' });
  await walletPost(`/wallet/${walletId}/credentials/receive`, { offerUrl: issued.offer, keyId });
  const issuance = data(await getIssuanceStatus({ client, path: { id: issued.id } }));
  const presentation = data(await createPresentation({ client, body: {} }));
  await walletPost(`/wallet/${walletId}/credentials/present`, { requestUrl: presentation.request });
  const before = data(await getPresentationResult({ client, path: { id: presentation.id } }));
  data(await revokeCredential({ client, path: { id: issued.credentialId }, body: {} }));
  const after = data(await getPresentationResult({ client, path: { id: presentation.id } }));
  if (issuance.state !== 'Completed' || !before.accepted || after.accepted || before.verifiedAt !== after.verifiedAt) throw Error('Unexpected real roundtrip outcome');
  console.log(JSON.stringify({ credentialId: issued.credentialId, issued: true, acceptedBeforeRevocation: true, acceptedAfterRevocation: false, historicalProofPreserved: true }));
} catch { console.error('Example failed. Check the API/wallet configuration, key, native PostgreSQL state and one-attempt policy. No raw request or credential is printed.'); process.exitCode = 1; }
