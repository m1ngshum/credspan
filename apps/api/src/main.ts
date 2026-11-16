import { createApplication } from './app.js';
import { readConfig } from './config.js';

try {
  const config = readConfig();
  const application = await createApplication(config);
  try { await application.app.listen(config.port, config.host); } catch (error) { await application.close(); throw error; }
  console.log(`Credspan sandbox listening on ${config.host}:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void application.close().then(() => process.exit(0)); });
} catch { console.error('Credspan startup failed; check sandbox configuration and PostgreSQL availability'); process.exitCode = 1; }
