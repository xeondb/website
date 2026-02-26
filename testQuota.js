
const { XeondbClient } = require("xeondb-driver");

const log = require('./lib/log');

// Drop the db data
// DROP TABLE test_table;

const client = new XeondbClient({
	host: 'au-central.xeondb.com',
    port: 9876,
	username: 'xeon_d1727f893bdc5efa3e037af0',
	password: 'bf1041b8db5114d1f0b6a4bb32d9f4d8',
});

async function pushLargeData() {
	const keyspace = 'xeon_free_d1727f';
	const table = 'test_table';
	let pushedChunks = 0;
	try {
		await client.connect();
		log.info('Connected to Xeondb.');

		await client.selectKeyspace(keyspace);

		await client.query(`CREATE TABLE IF NOT EXISTS ${table} (key varchar, value varchar, PRIMARY KEY (key));`);

		try {
			const metrics = await client.query(`SHOW METRICS IN ${keyspace};`);
			if (metrics && metrics.ok === true) {
				log.info('Metrics: %j', metrics);
			}
		} catch {
			// ignore
		}


		const chunkSize = 512 * 1024; // 512KB
		const totalChunks = Math.ceil((600 * 1024 * 1024) / chunkSize); // 600MB
		const dataChunk = Buffer.alloc(chunkSize, 'a');

		for (let i = 0; i < totalChunks; i++) {
			const key = `test_key_${i}`;
			const base64 = dataChunk.toString('base64');
			const cmd = `INSERT INTO ${table} (key, value) VALUES ("${key}", "${base64}");`;
			const res = await client.query(cmd);
			if (!res || res.ok !== true) {
				log.error(`Error inserting chunk ${i + 1}: %s`, (res && res.error) ? res.error : 'Query failed');
				break;
			}
			pushedChunks++;
			log.info(`Pushed chunk ${i + 1}/${totalChunks}`);
		}
		log.info(`Done. Successfully pushed ${pushedChunks} chunk(s) (~${(pushedChunks * chunkSize) / (1024 * 1024)} MB raw).`);
		client.close();
	} catch (err) {
		log.error('Error during data push: %s', err && err.message ? err.message : String(err));
	}
}

pushLargeData();
