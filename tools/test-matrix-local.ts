import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as util from 'util';

// --- Configuration ---
const CONFIG_FILE = path.resolve(__dirname, '../test-matrix.json');
const NETWORK_NAME = 'mongodash-local-matrix-net';
const MONGO_CONTAINER_NAME = 'mongodash-local-mongo';
const NODE_CONTAINER_NAME = 'mongodash-local-node';

interface TestMatrix {
    'node-version': string[];
    'mongodb-version': string[];
    'mongodb-driver-version': string[];
}

interface TestOptions {
    nodeVersion: string;
    mongoVersion: string;
    driverVersion: string;
    all: boolean;
}

// --- Helpers ---
const exec = util.promisify(child_process.exec);
const spawn = (cmd: string, args: string[], opts?: child_process.SpawnOptions) => {
    return new Promise<void>((resolve, reject) => {
        const proc = child_process.spawn(cmd, args, { stdio: 'inherit', ...opts });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command ${cmd} ${args.join(' ')} failed with code ${code}`));
        });
        proc.on('error', reject);
    });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Main Logic ---

async function loadMatrix(): Promise<TestMatrix> {
    const content = await fs.promises.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
}

function parseArgs(matrix: TestMatrix): TestOptions {
    const args = process.argv.slice(2);
    const options: TestOptions = {
        nodeVersion: matrix['node-version'][0], // Default to first (usually latest)
        mongoVersion: matrix['mongodb-version'][0], // Default to first
        driverVersion: matrix['mongodb-driver-version'][0], // Default to first
        all: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--node':
                options.nodeVersion = args[++i];
                break;
            case '--mongo':
                options.mongoVersion = args[++i];
                break;
            case '--driver':
                options.driverVersion = args[++i];
                break;
            case '--all':
                options.all = true;
                break;
            case '--help':
                console.log('Usage: ts-node tools/test-matrix-local.ts [options]');
                console.log('Options:');
                console.log(`  --node <ver>    Node.js version (choices: ${matrix['node-version'].join(', ')}) [default: ${options.nodeVersion}]`);
                console.log(`  --mongo <ver>   MongoDB version (choices: ${matrix['mongodb-version'].join(', ')}) [default: ${options.mongoVersion}]`);
                console.log(`  --driver <ver>  Driver version  (choices: ${matrix['mongodb-driver-version'].join(', ')}) [default: ${options.driverVersion}]`);
                console.log('  --all           Run all combinations locally (sanity check)');
                process.exit(0);
        }
    }
    return options;
}

async function cleanupContainers() {
    try {
        await exec(`docker rm -f ${MONGO_CONTAINER_NAME} ${NODE_CONTAINER_NAME}`);
    } catch {
        // Ignore errors if they don't exist
    }
    try {
        await exec(`docker network rm ${NETWORK_NAME}`);
    } catch {
        // Ignore
    }
}

async function runTest(options: TestOptions) {
    console.log(`\n>>> Running test with: Node ${options.nodeVersion}, Mongo ${options.mongoVersion}, Driver ${options.driverVersion}`);

    try {
        await cleanupContainers();

        // 1. Create Network
        console.log('Creating Docker network...');
        await exec(`docker network create ${NETWORK_NAME}`);

        // 2. Start MongoDB
        console.log(`Starting MongoDB ${options.mongoVersion}...`);
        // Use mongo:version tag. For 4.x/5.x/6.x/7.x usually just number works or number.0
        // Matrix has "7", "8".
        const mongoImage = `mongo:${options.mongoVersion}`;
        await exec(`docker run -d --name ${MONGO_CONTAINER_NAME} --network ${NETWORK_NAME} ${mongoImage} mongod --replSet rs0`);

        // Wait for Mongo to be ready
        console.log('Waiting for MongoDB to accept connections...');
        let retries = 30;
        let connected = false;
        while (retries > 0) {
            try {
                // Try simple eval inside container
                await exec(`docker exec ${MONGO_CONTAINER_NAME} mongosh --eval "db.adminCommand('ping')" --quiet`);
                connected = true;
                break;
            } catch {
                // Try legacy mongo shell if mongosh missing (older versions)
                try {
                    await exec(`docker exec ${MONGO_CONTAINER_NAME} mongo --eval "db.adminCommand('ping')" --quiet`);
                    connected = true;
                    break;
                } catch {
                    await sleep(1000);
                    retries--;
                }
            }
        }
        if (!connected) throw new Error('MongoDB failed to start or is unreachable');

        // Initiate Replica Set
        console.log('Initiating Replica Set...');
        // Try mongosh first, then mongo
        try {
            await exec(
                `docker exec ${MONGO_CONTAINER_NAME} mongosh --eval "try { rs.initiate(); } catch(e) { if (e.codeName !== 'AlreadyInitialized') throw e; }" --quiet`,
            );
        } catch {
            await exec(
                `docker exec ${MONGO_CONTAINER_NAME} mongo --eval "try { rs.initiate(); } catch(e) { if (e.codeName !== 'AlreadyInitialized') throw e; }" --quiet`,
            );
        }

        // Wait for Primary
        console.log('Waiting for Primary...');
        await sleep(2000); // Give it a moment to elect

        // 3. Run Node Tests
        console.log(`Starting Node.js ${options.nodeVersion} test runner...`);
        const projectRoot = path.resolve(__dirname, '..');

        // We mount the project root.
        // WARNING: node_modules might be architecture dependent if using native addons (snappy, etc).
        // While mongodash dependencies seem mostly pure JS, `mongodb` driver might have optional deps.
        // Best practice is to install deps INSIDE container.
        // We will mount to /app, but use a separate internal /app/node_modules if we assume host is mac (arm64) and container might be linux/amd64 or similar.
        // However, standard node image is usually same arch as host.
        // To be safe and clean, we should run `npm ci` inside.

        // Command script
        const testScript = [
            'echo ">>> Inside Container Setup"',
            'npm install -g npm@latest', // Ensure npm is decent
            'npm ci',
            `npm install mongodb@${options.driverVersion}`,
            'npx tsc', // Ensure build is fresh or just rely on ts-node in tests?
            // package.json test:simple runs jest directly (ts-jest)
            'echo ">>> Running Tests"',
            // We need to point to the mongo container.
            // In CI we might use explicit hostname. in docker network it is the container name.
            `export MONGODB_URI="mongodb://${MONGO_CONTAINER_NAME}:27017/mongodashTesting?replicaSet=rs0&directConnection=true"`,
            'npm run test:simple',
        ].join(' && ');

        await spawn('docker', [
            'run',
            '--rm',
            '--name',
            NODE_CONTAINER_NAME,
            '--network',
            NETWORK_NAME,
            '-v',
            `${projectRoot}:/app`,
            '-w',
            '/app',
            // '-e', 'CI=true', // Maybe?
            `node:${options.nodeVersion}`,
            '/bin/sh',
            '-c',
            testScript,
        ]);

        console.log('✅ Test run passed!');
    } catch (err) {
        console.error('❌ Test run failed:', err);
        throw err;
    } finally {
        await cleanupContainers();
    }
}

async function main() {
    try {
        const matrix = await loadMatrix();
        const options = parseArgs(matrix);

        if (options.all) {
            console.log('Running ALL matrix combinations...');
            for (const n of matrix['node-version']) {
                for (const m of matrix['mongodb-version']) {
                    for (const d of matrix['mongodb-driver-version']) {
                        await runTest({ nodeVersion: n, mongoVersion: m, driverVersion: d, all: false });
                    }
                }
            }
        } else {
            await runTest(options);
        }
    } catch {
        process.exit(1);
    }
}

main();
