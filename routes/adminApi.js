const router = require('express').Router();

const { XeondbClient } = require('xeondb-driver');

const requireAdmin = require('./requireAdmin');

const { cleanEmail, cleanSQL, isIdentifier, getReqDb } = require('../lib/shared');
const { listUsers, deleteUserByEmail } = require('../database/table/user');
const { listInstances, getInstancesByUser, getInstanceById } = require('../database/table/instances');
const { listWhitelistByInstance, deleteWhitelistEntryById } = require('../database/table/whitelist');
const { listBackupsByInstance, deleteBackupRow } = require('../database/table/backups');
const { connectRootClientForInstance } = require('../lib/rootClient');

router.use(requireAdmin);

function safeInstanceForAdmin(inst) {
  const out = { ...(inst || {}) };
  delete out.db_password;
  return out;
}

async function deleteWebsiteRowsForInstance(db, instanceId) {
  const wl = await listWhitelistByInstance(db, instanceId);
  for (const e of wl) {
    try {
      await deleteWhitelistEntryById(db, e.id);
    } catch {
      // ignore
    }
  }

  const backups = await listBackupsByInstance(db, instanceId);
  for (const b of backups) {
    try {
      await deleteBackupRow(db, { instanceId, id: b.id });
    } catch {
      // ignore
    }
  }

  const q = `DELETE FROM instances WHERE id=${cleanSQL(instanceId)};`;
  const del = await db.query(q);
  if (!del || del.ok !== true) throw new Error((del && del.error) || 'Failed to delete instance row');
}

async function deprovisionInstanceForReal(instance) {
  const keyspace = instance && instance.keyspace ? String(instance.keyspace).trim() : '';
  const username = instance && instance.db_username ? String(instance.db_username).trim() : '';
  const expectedUser = `xeon_${String(instance && instance.id ? instance.id : '').trim()}`;

  if (!keyspace || !isIdentifier(keyspace) || !keyspace.startsWith('xeon_')) {
    throw new Error('Refusing to deprovision: invalid keyspace');
  }
  if (!username || !isIdentifier(username) || !username.startsWith('xeon_')) {
    throw new Error('Refusing to deprovision: invalid db username');
  }
  if (!expectedUser || username !== expectedUser) {
    throw new Error('Refusing to deprovision: db username does not match instance id');
  }

  let client = null;
  try {
    client = await connectRootClientForInstance(instance);

    // Revoke grants for this keyspace
    try {
      const grantsRes = await client.query('SELECT * FROM SYSTEM.KEYSPACE_GRANTS ORDER BY keyspace_username ASC;');
      if (!grantsRes || grantsRes.ok !== true) throw new Error((grantsRes && grantsRes.error) || 'Failed to list grants');
      const rows = Array.isArray(grantsRes.rows) ? grantsRes.rows : [];
      const prefix = keyspace + '#';
      for (const r of rows) {
        const ksu = r && (r.keyspace_username || r.keyspaceUsername) ? String(r.keyspace_username || r.keyspaceUsername) : '';
        if (!ksu || !ksu.startsWith(prefix)) continue;
        try {
          const del = await client.query(`DELETE FROM SYSTEM.KEYSPACE_GRANTS WHERE keyspace_username=${cleanSQL(ksu)};`);
          if (!del || del.ok !== true) throw new Error((del && del.error) || 'Failed to delete grant');
        } catch {
          // ignore individual grant delete failures
        }
      }
    } catch {
      // ignore grants cleanup failures
    }

    // Remove owner/quota rows (best effort)
    try {
      await client.query(`DELETE FROM SYSTEM.KEYSPACE_OWNERS WHERE keyspace=${cleanSQL(keyspace)};`);
    } catch {
      // ignore
    }
    try {
      await client.query(`DELETE FROM SYSTEM.KEYSPACE_QUOTAS WHERE keyspace=${cleanSQL(keyspace)};`);
    } catch {
      // ignore
    }

    // Drop keyspace (critical)
    {
      const drop = await client.query(`DROP KEYSPACE ${keyspace};`);
      if (!drop || drop.ok !== true) {
        throw new Error((drop && drop.error) || 'Failed to drop keyspace');
      }
    }

    // Delete generated db user (best effort)
    try {
      await client.query(`DELETE FROM SYSTEM.USERS WHERE username=${cleanSQL(username)};`);
    } catch {
      // ignore
    }
  } finally {
    try {
      if (client) client.close();
    } catch {
      // ignore
    }
  }
}

router.get('/overview', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  try {
    const users = await listUsers(db);
    const instances = await listInstances(db);
    const safeInstances = (instances || []).map(safeInstanceForAdmin);
    return res.json({ ok: true, users, instances: safeInstances });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Failed to load overview' });
  }
});

router.get('/instances/:id/metrics', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

  let client = null;
  try {
    const instance = await getInstanceById(db, id);
    if (!instance) return res.status(404).json({ ok: false, error: 'Instance not found' });

    const keyspace = instance && typeof instance.keyspace === 'string' ? String(instance.keyspace || '').trim() : '';
    if (!keyspace || !isIdentifier(keyspace)) {
      return res.status(400).json({ ok: false, error: 'Invalid keyspace' });
    }

    client = new XeondbClient({
      host: instance.host,
      port: Number(instance.port),
      username: instance.db_username,
      password: instance.db_password
    });

    const connected = await client.connect();
    if (!connected) return res.status(502).json({ ok: false, error: 'Unable to connect to instance' });

    const q = `SHOW METRICS IN ${keyspace};`;
    const result = await client.query(q);
    if (!result || result.ok !== true) {
      return res.status(400).json({ ok: false, error: (result && result.error) || 'Failed to load metrics' });
    }

    const bytesUsed = Object.prototype.hasOwnProperty.call(result, 'bytes_used') ? Number(result.bytes_used) : 0;
    const quotaBytes = Object.prototype.hasOwnProperty.call(result, 'quota_bytes') ? Number(result.quota_bytes) : 0;
    const overQuota = result && result.over_quota === true;

    return res.json({ ok: true, bytes_used: bytesUsed, quota_bytes: quotaBytes, over_quota: overQuota, metrics: result });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err && err.message ? err.message : 'Failed' });
  } finally {
    try {
      if (client) client.close();
    } catch {
      // ignore
    }
  }
});

router.delete('/instances/:id', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

  try {
    const instance = await getInstanceById(db, id);
    if (!instance) return res.status(404).json({ ok: false, error: 'Instance not found' });

    await deprovisionInstanceForReal(instance);
    await deleteWebsiteRowsForInstance(db, id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err && err.message ? err.message : 'Failed to delete instance' });
  }
});

router.delete('/users/:email', async (req, res) => {
  const db = getReqDb(req);
  if (!db) return res.status(500).json({ ok: false, error: 'Database not ready' });

  let raw = String(req.params.email || '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // ignore
  }
  const email = cleanEmail(raw);
  if (!email) return res.status(400).json({ ok: false, error: 'email is required' });

  try {
    const instances = await getInstancesByUser(db, email);
    const deleted = [];

    for (const inst of instances) {
      try {
        await deprovisionInstanceForReal(inst);
        await deleteWebsiteRowsForInstance(db, String(inst.id));
        deleted.push(String(inst.id));
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error: err && err.message ? err.message : 'Failed while deleting instances',
          failedInstanceId: inst && inst.id ? String(inst.id) : null,
          deletedInstanceIds: deleted
        });
      }
    }

    await deleteUserByEmail(db, email);
    return res.json({ ok: true, deletedInstanceIds: deleted });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err && err.message ? err.message : 'Failed to delete user' });
  }
});

module.exports = router;
