import { createServer, IncomingMessage, ServerResponse } from 'http';
import { MongoClient } from 'mongodb';
import { init, reactiveTask, cronTask, serveDashboard, startReactiveTasks, startCronTasks, getPrometheusMetrics } from '../src/index';

const { getConnectionString } = require('../tools/testingDatabase');

// --- Configuration ---
const MONGO_URL = getConnectionString();
const DB_NAME = 'mongodash_playground';
const PORT = 3000;

async function main() {
    console.log(`Connecting to MongoDB at ${MONGO_URL}/${DB_NAME}...`);
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(DB_NAME);

    // Drop the entire database for a fresh start
    console.log('Dropping database for fresh start...');
    await db.dropDatabase();

    // --- Init Mongodash ---
    console.log('Initializing Mongodash...');
    await init({
        mongoClient: client,
        cronTaskCaller: (task) => task(),
        reactiveTaskCaller: (task) => task(),
        // We use the playground DB for globals and tasks
        globalsCollection: db.collection('_mongodash_globals'),
        collectionFactory: (name) => db.collection(name),
        monitoring: {
            enabled: true,
            pushIntervalMs: 10000, // Short interval for playground
        },
    });

    // --- Define Tasks ---
    console.log('Registering Tasks...');

    // 1. Reactive Task: Simple greeter
    await reactiveTask({
        task: 'greeter',
        filter: {},
        collection: 'greeter_queue',
        debounce: 15 * 1000,
        handler: async (ctx) => {
            console.log(`[Reactive] Hello from doc ${ctx.docId}`);
            // Randomly fail to show error state in UI
            if (Math.random() > 0.5) throw new Error('Random greeter failure!');
        },
    });

    // 2. Reactive Task: Data Processor (simulated delay)
    await reactiveTask({
        task: 'processor',
        collection: 'processor_queue',
        filter: { type: 'process_me' },
        handler: async (ctx) => {
            console.log(`[Reactive] Processing doc ${ctx.docId}...`);
            await new Promise((resolve) => setTimeout(resolve, 2000)); // 2s processing
            console.log(`[Reactive] Processed doc ${ctx.docId}`);
        },
    });

    // 3. Cron Task: Fast ticker (every 10s)
    await cronTask('ticker-10s', 'CRON */10 * * * * *', async () => {
        console.log('[Cron] Ticker 10s running...');
        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    // 4. Cron Task: Hourly report (manual trigger candidate)
    await cronTask('hourly-report', 'CRON 0 * * * *', async () => {
        console.log('[Cron] Generating hourly report...');
        await new Promise((resolve) => setTimeout(resolve, 3000));
    });

    // Start Schedulers
    console.log('Starting Schedulers...');
    await startCronTasks();
    await startReactiveTasks();
    console.log('Schedulers started.');

    // --- HTTP Server ---
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        console.log(`${req.method} ${req.url}`);

        // Redirect / => /dashboard/ and /tasks => /dashboard/
        if (req.url === '/' || req.url === '' || req.url?.startsWith('/tasks')) {
            res.writeHead(302, { Location: '/dashboard/' });
            res.end();
            return;
        }

        // Metrics endpoint
        if (req.url === '/metrics') {
            const registry = await getPrometheusMetrics();
            if (registry) {
                res.setHeader('Content-Type', registry.contentType);
                res.end(await registry.metrics());
            } else {
                res.statusCode = 503;
                res.end('Monitoring disabled');
            }
            return;
        }

        // Handle dashboard routes
        // serveDashboard handles API (/api/...) and static files.
        // It returns true if it handled the request.
        const handled = await serveDashboard(req, res);

        if (!handled) {
            res.statusCode = 404;
            res.end('Not Found. Try /dashboard/');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Playground Server running at http://localhost:${PORT}/dashboard/\n`);
    });

    // Seed some data for reactive tasks
    setInterval(async () => {
        // Insert a doc for 'greeter' every 5s
        try {
            await db.collection('greeter_queue').insertOne({
                created: new Date(),
                status: 'pending',
            });
        } catch {
            // ignore
        }
    }, 5000);
}

main().catch(console.error);
