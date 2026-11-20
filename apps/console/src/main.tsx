import { useRef, useState, useEffect, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createIssuance, createPresentation, getIssuanceStatus, getPresentationResult, revokeCredential, type CreateIssuanceResponse, type CreatePresentationResponse, type GetPresentationResultResponse } from '@credspan/sdk';
import { Connection } from './connection';
import { displayNameError, copyCapability } from './validation';
import logo from '../../../docs/assets/brand/lockup.svg?no-inline';
import './style.css';

function App() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const active = useRef<Connection | null>(null);
  const [connected, setConnected] = useState(false), [key, setKey] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [name, setName] = useState(''), [memberId, setMemberId] = useState('');
  const nameError = nameTouched ? displayNameError(name) : undefined;
  const [issued, setIssued] = useState<CreateIssuanceResponse>(), [presentation, setPresentation] = useState<CreatePresentationResponse>();
  const [result, setResult] = useState<GetPresentationResultResponse>(), [state, setState] = useState('');
  const [notice, setNotice] = useState('Connect to begin. Use synthetic member details only.');
  const [pending, setPending] = useState<string>(), [revoked, setRevoked] = useState(false), [confirm, setConfirm] = useState(false);
  const accepted = result?.accepted && now < Math.min(Date.parse(result.authorizationExpiresAt), Date.parse(result.expiresAt));
  function disconnect(message = 'Disconnected. The key and session details have been cleared.') {
    active.current?.close(); active.current = null; setConnected(false); setKey(''); setIssued(undefined); setPresentation(undefined); setResult(undefined); setState(''); setPending(undefined); setConfirm(false); setRevoked(false); setName(''); setNameTouched(false); setMemberId(''); setNotice(message);
  }
  function connect(event: FormEvent) { event.preventDefault(); active.current?.close(); active.current = new Connection(key, location.origin); setConnected(true); setKey(''); setNotice('Key loaded in memory. It will be checked on your first request.'); }
  async function run<T>(scope: string, operation: (connection: Connection, signal: AbortSignal) => Promise<{ data?: T; response?: Response }>, success: (data: T) => void) {
    const connection = active.current; if (!connection) return;
    setPending(scope); setNotice('Working…');
    const response = await connection.run(scope, signal => operation(connection, signal));
    if (active.current !== connection || response.kind === 'stale') return;
    setPending(undefined);
    if (response.kind === 'success') success(response.data);
    else if (response.status === 401) disconnect('Key rejected. Reconnect with a valid management key.');
    else setNotice(response.status ? `Request failed (${response.status}). Check the details and try again. A failed credential flow may need a fresh request.` : 'Service unavailable. Check API availability and your connection. For a hosted sandbox, check your access session.');
  }
  function issue(event: FormEvent) {
    event.preventDefault(); setNameTouched(true);
    if (displayNameError(name)) { document.getElementById('name')?.focus(); return; }
    setPresentation(undefined); setResult(undefined); setConfirm(false);
    active.current?.cancel('result');
    void run('issue', (connection, signal) => createIssuance({ client: connection.client, signal, body: { name, memberId } }), data => {
      setIssued(data); setState(''); setRevoked(false);
      setNotice('Offer created. Give the offer URL to your independent wallet. This does not mean a credential has been received.');
    });
  }
  function request() { setResult(undefined); setPresentation(undefined); active.current?.cancel('result'); void run('request', (connection, signal) => createPresentation({ client: connection.client, signal, body: {} }), data => { setPresentation(data); setNotice('Request created. Present from your independent wallet, then check the result. Each request permits one attempt.'); }); }
  function refresh() { if (!presentation) return; setResult(undefined); void run('result', (connection, signal) => getPresentationResult({ client: connection.client, signal, path: { id: presentation.id } }), data => { setResult(data); setNotice(data.accepted ? 'Accepted at last check. Refresh to check current credential validity.' : 'Not accepted. The request may be pending, denied, expired, revoked or unavailable.'); }); }
  function revoke() { if (!issued) return; setResult(undefined); active.current?.cancel('result'); void run('revoke', (connection, signal) => revokeCredential({ client: connection.client, signal, path: { id: issued.credentialId }, body: {} }), () => { setRevoked(true); setConfirm(false); setNotice(presentation ? 'Credential revoked. Check the presentation result again to see its current acceptance.' : 'Credential revoked.'); }); }
  return <><header><a className="brand" href="/console/"><img src={logo} alt="Credspan" width="216" height="56"/><span className="brand-sub">Open credentials. Built to run.</span></a><span className="badge">Synthetic sandbox</span></header>
    <main><div className="intro"><h1>Your data. Your proof. Your choice.</h1><p>Use this sandbox to issue, verify and revoke synthetic credentials.</p></div>
      <section className="connection" aria-labelledby="connection-title"><div><h2 id="connection-title">Your connection</h2><p>One administrator. Synthetic data only. Key stays in memory.</p></div>{connected ? <button className="secondary" onClick={() => disconnect()}>Disconnect</button> : <form onSubmit={connect}><div className="key-field"><label htmlFor="management-key">Management key</label><input id="management-key" type="password" value={key} onChange={event => setKey(event.target.value)} placeholder="Enter your management key" autoComplete="off" required minLength={32}/></div><button>Connect</button></form>}</section>
      <div className="notice" role="status" aria-live="polite">{notice}</div>
      <div className="workflow"><section className="card" aria-busy={pending === 'issue' || pending === 'issuance-status'}><div className="step">01 <span>Issue</span></div><h2>Create a membership</h2><p>A fixed profile with a server-set ID and one-hour expiry.</p><form onSubmit={issue}><label htmlFor="name">Display name</label><input id="name" value={name} onChange={event => setName(event.target.value)} onBlur={() => setNameTouched(true)} aria-invalid={!!nameError} aria-describedby={nameError ? "name-help name-error" : "name-help"} maxLength={200} required disabled={!connected || !!pending} placeholder="Alex Example"/><p id="name-help" className="fine">Up to 100 Unicode code points. No control characters.</p>{nameError && <p id="name-error" className="field-error" role="alert">{nameError}</p>}<label htmlFor="member">Member ID</label><input id="member" value={memberId} onChange={event => setMemberId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" maxLength={64} required disabled={!connected || !!pending} placeholder="member-001"/><button disabled={!connected || !!pending}>{pending === 'issue' ? 'Creating offer…' : 'Create offer'}</button></form>{issued && <div className="receipt"><p className="fine">Last successful offer</p><Capability key={issued.id} label="Credential offer" value={issued.offer}/><dl><dt>Credential ID</dt><dd>{issued.credentialId}</dd><dt>Expires</dt><dd>{new Date(issued.expiresAt).toLocaleString()}</dd></dl><button className="text" disabled={!!pending} onClick={() => void run('issuance-status', (connection, signal) => getIssuanceStatus({ client: connection.client, signal, path: { id: issued.id } }), data => { setState(data.state); setNotice('Issuance status updated.'); })}>{pending === 'issuance-status' ? 'Checking issuance…' : 'Check issuance status'}</button>{state && <p>Issuance: <strong>{state}</strong></p>}</div>}</section>
      <section className="card" aria-busy={pending === 'request' || pending === 'result'}><div className="step">02 <span>Verify</span></div><h2>Request a presentation</h2><p>Ask for the member ID only. The name stays in the wallet.</p><button disabled={!connected || !!pending} onClick={request}>{pending === 'request' ? 'Creating request…' : 'Create request'}</button>{presentation && <div className="receipt"><Capability label="Presentation request" value={presentation.request}/><p className="fine">Original request expires {new Date(presentation.expiresAt).toLocaleString()}. A failed attempt needs a fresh request.</p><button className="secondary" disabled={!!pending} onClick={refresh}>{pending === 'result' ? 'Checking presentation…' : 'Check presentation result'}</button></div>}{result && <div className={accepted ? 'outcome accepted' : 'outcome'}><h3>{accepted ? 'Accepted at last check' : 'Not accepted'}</h3>{accepted && result.accepted && <p>Member <strong>{result.memberId}</strong></p>}<dl>{'verifiedAt' in result && result.verifiedAt && <><dt>Original proof verified</dt><dd>{new Date(result.verifiedAt).toLocaleString()}</dd></>}<dt>Current check</dt><dd>{new Date(result.checkedAt).toLocaleString()}</dd>{'authorizationExpiresAt' in result && result.authorizationExpiresAt && <><dt>Authorization deadline</dt><dd>{new Date(result.authorizationExpiresAt).toLocaleString()}</dd></>}</dl><p className="fine">A status check is not a fresh sign-in and never extends the original deadline.</p></div>}</section>
      <section className="card" aria-busy={pending === 'revoke'}><div className="step">03 <span>Revoke</span></div><h2>Close the loop</h2><p>Revocation is permanent for this credential. Its original proof remains historical evidence.</p>{revoked ? <div className="outcome"><h3>Credential revoked</h3>{presentation && <p>Refresh the presentation result to check current acceptance.</p>}</div> : confirm ? <div className="confirm"><p>Revoke this issued credential permanently?</p><p className="fine">{issued?.credentialId}</p><button disabled={!!pending} onClick={revoke}>{pending === 'revoke' ? 'Revoking credential…' : 'Confirm revocation'}</button><button className="text" onClick={() => setConfirm(false)}>Cancel</button></div> : <button className="secondary" disabled={!connected || !issued || !!pending} onClick={() => setConfirm(true)}>Revoke issued credential</button>}<div className="boundary"><h3>Know the boundary</h3><p>This console manages one local membership cohort. It is not a production identity service or a national wallet certification.</p><a href="/openapi.json" target="_blank" rel="noreferrer">Management API contract</a></div></section></div>
    </main><footer><span>Credspan / Local developer tools</span><span>Independent wallet. Real proofs. Explicit limits.</span></footer></>;
}
function Capability({ label, value }: { label: string; value: string }) {
  const [copyNotice, setCopyNotice] = useState('');
  return <div className="capability"><label>{label}<textarea readOnly value={value} rows={3} aria-label={label}/></label><button type="button" className="text" onClick={async () => setCopyNotice(await copyCapability(value, text => navigator.clipboard.writeText(text)))}>{copyNotice === 'Copied to clipboard.' ? 'Copied' : `Copy ${label.toLowerCase()}`}</button>{copyNotice && <p className="fine" role="status">{copyNotice}</p>}<p className="fine">Short-lived capability. Copy to your wallet; do not share publicly.</p></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
