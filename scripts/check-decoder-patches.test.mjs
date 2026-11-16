import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const hash=(value,alg)=>createHash(alg.replace('-','')).update(value).digest();
const digest=value=>hash(value,'sha-256').toString('base64url');
const token=(payload,disclosures)=>`${encode({alg:'EdDSA'})}.${encode(payload)}.c2ln~${disclosures.join('~')}${disclosures.length?'~':''}`;
const fromApi=createRequire(resolve('apps/api/package.json'));
const fromCore=createRequire(fromApi.resolve('@credo-ts/core'));
const pexEntry=fromCore.resolve('@animo-id/pex'),fromPex=createRequire(pexEntry);
const sphereonEntry=fromPex.resolve('@sphereon/ssi-types'),fromSphereon=createRequire(sphereonEntry);
const resolvedDecoders={};
for(const caller of [fromSphereon,fromPex]){const entry=caller.resolve('@sd-jwt/decode');const metadata=JSON.parse(await readFile(join(dirname(entry),'../package.json')));resolvedDecoders[metadata.version]=entry;}
assert.deepEqual(Object.keys(resolvedDecoders).sort(),['0.7.2','0.9.2']);
for(const version of ['0.7.2','0.9.2'])for(const format of ['mjs','js'])test(`legacy decoder ${version} ${format} security backport preserves selective object/array APIs`,async()=>{
 const resolvedEntry=resolvedDecoders[version];
 const patchHash=createHash('sha256').update(await readFile(new URL('../patches/@sd-jwt__decode@'+version+'.patch',import.meta.url))).digest('hex');
 assert.ok(resolvedEntry.includes('@sd-jwt+decode@'+version+'_patch_hash='+patchHash),'Actual caller resolves the exact content-hashed patch');
 assert.equal(JSON.parse(await readFile(join(dirname(resolvedEntry),'../package.json'))).version,version);
 const path=join(dirname(resolvedEntry),'index.'+format);
 const api=format==='js'?require(path):await import(pathToFileURL(path));
 const inner=encode(['inner-salt','memberId','synthetic-member']);
 const outer=encode(['outer-salt','membership',{_sd:[digest(inner)]}]);
 const array=encode(['array-salt','synthetic-array-value']);
 const payload={iss:'synthetic-issuer',_sd:[digest(outer)],items:[{'...':digest(array)}]};
 const compact=token(payload,[inner,outer,array]);
 for(const mode of ['sync','async']){
  const decoded=mode==='sync'?api.decodeSdJwtSync(compact,hash):await api.decodeSdJwt(compact,hash);
  const claims=mode==='sync'?api.getClaimsSync(decoded.jwt.payload,decoded.disclosures,hash):await api.getClaims(decoded.jwt.payload,decoded.disclosures,hash);
  assert.deepEqual(claims,{iss:'synthetic-issuer',membership:{memberId:'synthetic-member'},items:['synthetic-array-value']});
  const omitted=mode==='sync'?api.decodeSdJwtSync(token(payload,[outer]),hash):await api.decodeSdJwt(token(payload,[outer]),hash);
  const reduced=mode==='sync'?api.getClaimsSync(omitted.jwt.payload,omitted.disclosures,hash):await api.getClaims(omitted.jwt.payload,omitted.disclosures,hash);
  assert.deepEqual(reduced,{iss:'synthetic-issuer',membership:{},items:[]});
  const reject=async(p,ds)=>{const operation=async()=>{const d=mode==='sync'?api.decodeSdJwtSync(token(p,ds),hash):await api.decodeSdJwt(token(p,ds),hash);return mode==='sync'?api.getClaimsSync(d.jwt.payload,d.disclosures,hash):api.getClaims(d.jwt.payload,d.disclosures,hash);};await assert.rejects(operation);};
  await reject(payload,[inner,outer,array,encode(['other','tampered',true])]);
  await reject(payload,[inner,outer,array,array]);
  await reject({...payload,_sd:[digest(outer),digest(outer)]},[outer]);
  await reject({_sd:[digest(array)]},[array]);
  await reject({items:[{'...':digest(outer)}]},[outer]);
  await reject({nested:{_sd:['same-digest']},items:[{'...':'same-digest'}]},[]);
  await reject({_sd_alg:'md5'},[]);
  await reject({_sd_alg:123},[]);
  await reject({_sd:['x']},['%%%']);
  await reject({_sd:['x']},[Buffer.from([0xff]).toString('base64url')]);
  await reject({_sd:['x']},[encode(['salt','_sd','reserved'])]);
  const conflict=encode(['salt','iss','replacement']);await reject({iss:'original',_sd:[digest(conflict)]},[conflict]);
 }
 // PEX uses the serialized map API without decodeSdJwt/getClaims.
 const serialized={salt:'array-salt',value:'synthetic-array-value',encoded:array};
 assert.deepEqual(api.unpackObj({items:[{'...':digest(array)}]},{[digest(array)]:serialized}).unpackedObj,{items:['synthetic-array-value']});
 assert.throws(()=>api.unpackObj({}, {[digest(array)]:serialized}),/Unreferenced/);
 assert.throws(()=>api.unpackObj({nested:{_sd:['same-digest']},items:[{'...':'same-digest'}]},{}),/Duplicate/);
 assert.throws(()=>api.unpackObj({left:{_sd:['same-digest']},right:{nested:{_sd:['same-digest']}}},{}),/Duplicate/);
 assert.throws(()=>api.unpackObj({items:[{'...':digest(array)},{'...':digest(array)}]}, {[digest(array)]:serialized}),/Duplicate/);
 assert.throws(()=>api.decodeJwt(`${encode({})}.${Buffer.from([0xff]).toString('base64url')}.c2ln`));
});
test('actual Sphereon decoder and PEX disclosure selection retain their legacy object contract',async()=>{
 const {decodeSdJwtVc,decodeSdJwtVcAsync}=require(join(dirname(sphereonEntry),'types/sd-jwt-vc.js'));
 const {applySdJwtLimitDisclosure}=require(join(dirname(pexEntry),'lib/utils/sdJwt.js'));
 const member=encode(['salt','memberId','synthetic-member']),optional=encode(['salt2','name','Synthetic']);
 const payload={iss:'synthetic-issuer',_sd:[digest(member),digest(optional)]};
 for(const decode of [decodeSdJwtVc,decodeSdJwtVcAsync]){
  const decoded=await decode(token(payload,[member,optional]),hash);
  assert.equal(decoded.disclosures.length,2);assert.equal(decoded.decodedPayload.memberId,'synthetic-member');
  applySdJwtLimitDisclosure(decoded,{memberId:true});
  assert.equal(decoded.disclosures.length,1);assert.deepEqual(decoded.decodedPayload,{iss:'synthetic-issuer',memberId:'synthetic-member'});
  await assert.rejects(async()=>decode(token(payload,[member,optional,encode(['unreferenced','forged',true])]),hash));
  for(const name of ['a.b','a~b']){const item=encode(['literal-salt',name,'literal-value']);const literal=await decode(token({_sd:[digest(item)]},[item]),hash);applySdJwtLimitDisclosure(literal,{[name]:true});assert.equal(literal.disclosures.length,1);assert.equal(literal.decodedPayload[name],'literal-value');}
 }
});
