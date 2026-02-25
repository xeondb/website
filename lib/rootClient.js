const { XeondbClient } = require('xeondb-driver');

function instancePool(envValue) {
  if (!envValue) return [];
  try {
    let parsed = null;
    try {
      parsed = JSON.parse(envValue);
    } catch {
      const relaxed = String(envValue)
        .trim()
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
      parsed = JSON.parse(relaxed);
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => ({
        host: typeof v.host === 'string' ? v.host : null,
        port: typeof v.port === 'number' ? v.port : Number(v.port),
        username: typeof v.username === 'string' ? v.username : null,
        password: typeof v.password === 'string' ? v.password : null
      }))
      .filter((v) => !!v.host && Number.isFinite(v.port) && v.port > 0);
  } catch {
    return [];
  }
}

function findRootCredsForInstance(instance) {
  const host = instance && instance.host ? String(instance.host) : '';
  const port = instance && instance.port ? Number(instance.port) : NaN;
  if (!host || !Number.isFinite(port)) return null;

  const plan = String(instance && instance.plan ? instance.plan : '').trim().toLowerCase() === 'pro' ? 'pro' : 'free';

  const freePool = instancePool(process.env.FREE_INSTANCES);
  const paidPool = instancePool(process.env.PAID_INSTANCES);

  const pool = plan === 'pro' ? paidPool : freePool;
  const match = pool.find((p) => String(p.host) === host && Number(p.port) === port);
  if (match) return match;

  const match2 = [...freePool, ...paidPool].find((p) => String(p.host) === host && Number(p.port) === port);
  return match2 || null;
}

async function connectRootClientForInstance(instance) {
  const creds = findRootCredsForInstance(instance);
  if (!creds || !creds.username || !creds.password) {
    throw new Error('Missing root credentials for this instance host/port');
  }

  const client = new XeondbClient({
    host: String(creds.host),
    port: Number(creds.port),
    username: String(creds.username),
    password: String(creds.password)
  });
  const connected = await client.connect();
  if (!connected) {
    try {
      client.close();
    } catch {
      // ignore
    }
    throw new Error('Unable to connect to instance as root');
  }
  return client;
}

module.exports = {
  connectRootClientForInstance
};
