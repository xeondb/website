const { XeondbClient } = require("xeondb-driver");
const { ensureUsersTable } = require("./table/user.js");
const { ensureInstancesTable } = require("./table/instances.js");
const { ensureWhitelistTable } = require('./table/whitelist.js');
const { ensureBackupsTable } = require('./table/backups.js');

const { isIdentifier } = require('../lib/shared');
const log = require('../lib/log');

const DB_HOST = process.env.DB_HOST;
const DB_PORT = process.env.DB_PORT;
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;
const keyspace = process.env.DB_KEYSPACE;

function createClient() {
    if (DB_USERNAME && DB_PASSWORD) {
        return new XeondbClient({ host: DB_HOST, port: DB_PORT, username: DB_USERNAME, password: DB_PASSWORD });
    }
    return new XeondbClient({ host: DB_HOST, port: DB_PORT });
}

let client = createClient();
let connectingPromise = null;

function safeClose(c) {
    try {
        if (c) c.close();
    } catch {
        // ignore
    }
}

function isRecoverableDbError(err) {
    const msg = String(err && err.message ? err.message : err || '').toLowerCase();
    if (!msg) return false;
    if (msg.includes('not connected')) return true;
    if (msg.includes('connection closed')) return true;
    if (msg.includes('ecconnreset') || msg.includes('econnreset')) return true;
    if (msg.includes('broken pipe') || msg.includes('epipe')) return true;
    if (msg.includes('socket hang up')) return true;
    return false;
}

async function connectAndInit({ reconnect, reason } = {}) {
    if (connectingPromise) return connectingPromise;

    connectingPromise = (async () => {
        if (!isIdentifier(keyspace)) {
            throw new Error(`Invalid DB_KEYSPACE: '${keyspace}'`);
        }

        if (reconnect) {
            log.warn(
                `Re-connecting to Xeondb at ${DB_HOST}:${DB_PORT}...${reason ? ` (${reason})` : ''}`
            );
        } else {
            log.info(`Connecting to Xeondb at ${DB_HOST}:${DB_PORT}...`);
        }

        safeClose(client);
        client = createClient();

        const connected = await client.connect();
        if (!connected) {
            throw new Error('Unable to establish a connection to the database.');
        }

        if (reconnect) {
            log.info('Re-connected to the database.');
        } else {
            log.info('Successfully connected to the database.');
        }

        const res = await client.query(`CREATE KEYSPACE IF NOT EXISTS ${keyspace};`);
        if (!res || res.ok !== true) {
            throw new Error(`Failed to create or access keyspace: ${(res && res.error) || 'Unknown error'}`);
        }
        await client.selectKeyspace(keyspace);
        log.info(`Using keyspace: ${keyspace}`);

        await ensureUsersTable(client);
        await ensureInstancesTable(client);
        await ensureWhitelistTable(client);
        await ensureBackupsTable(client);

        return client;
    })().finally(() => {
        connectingPromise = null;
    });

    return connectingPromise;
}

function createManagedDb() {
    return {
        async query(cmd) {
            if (!client || client.connected !== true) {
                await connectAndInit({ reconnect: true, reason: 'disconnected' });
            }

            try {
                return await client.query(cmd);
            } catch (err) {
                if (!isRecoverableDbError(err)) throw err;
                await connectAndInit({ reconnect: true, reason: 'query failed' });
                return await client.query(cmd);
            }
        },
        close() {
            safeClose(client);
        },
        get connected() {
            return !!(client && client.connected === true);
        }
    };
}

async function connectToDb() {
    try {
        await connectAndInit({ reconnect: false });
        return createManagedDb();
    } catch (error) {
        log.error('Error connecting to the database: %s', error && error.message ? error.message : String(error));
        process.exit(1);
    }
}

module.exports = {
    connectToDb
};
