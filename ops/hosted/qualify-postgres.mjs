import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '/app/apps/api/node_modules/@openwallet-foundation/askar-nodejs/build/index.js';
try {
 const uri = `postgres://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST}/postgres?connect_timeout=10&max_connections=2`;
 const open = () => Store.open({ uri, passKey: process.env.ASKAR_STORE_KEY });
 if (process.env.QUALIFY_EXPECT_TLS_REJECTION === '1') {
   let opened;
   try { opened = await open(); } catch (error) { assert.match(error.message, /certificate|UnknownIssuer|BadSignature/i); console.log('Native TLS certificate rejection: PASS'); process.exit(0); }
   await opened.close(); throw Error('Invalid TLS configuration was accepted');
 }
 let store = await open(); let session = await store.openSession(false);
 const category = 'credspan-native-qualification', name = randomUUID();
 await session.insert({ category, name, value: { synthetic: true }, tags: { synthetic: 'yes' } });
 await assert.rejects(session.insert({ category, name, value: { synthetic: false } }));
 await session.close(); await store.close();
 store = await open(); session = await store.openSession(false);
 assert.equal((await session.fetch({ category, name, isJson: true })).value.synthetic, true);
 await session.replace({ category, name, value: { synthetic: 'updated' }, tags: { synthetic: 'yes' } });
 assert.equal((await session.fetch({ category, name, isJson: true })).value.synthetic, 'updated');
 await session.remove({ category, name }); assert.equal(await session.fetch({ category, name }), null);
 await session.close(); await store.close();
 console.log('Native runtime open/reopen/tagged CRUD/duplicate rejection: PASS');
} catch { console.error('Native runtime qualification failed; private details suppressed'); process.exitCode = 1; }
