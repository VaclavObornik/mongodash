import * as fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { parse as parseUrl } from 'url';
import { ReactiveTaskScheduler, _scheduler as defaultScheduler } from '../reactiveTasks/index';
import { OperationalTaskController } from './OperationalTaskController';

const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

export interface ServeDashboardOptions {
    dashboardPath?: string;
    scheduler?: ReactiveTaskScheduler;
}

/**
 * Serve the mongodash dashboard.
 * Framework-agnostic: Works with Express, Koa, or native Node.js http.
 * Returns true if the request was handled.
 */
export async function serveDashboard(req: IncomingMessage, res: ServerResponse, options: ServeDashboardOptions = {}): Promise<boolean> {
    const scheduler = options.scheduler || defaultScheduler;
    const controller = new OperationalTaskController(scheduler);

    // Default dashboard path: inside dist/dashboard of the package
    // When running from src..., it might be elsewhere, but we assume it's integrated.
    // __dirname is .../src/task-management
    let dashboardPath = options.dashboardPath;
    if (!dashboardPath) {
        dashboardPath = getResolvedDashboardPath();
    }

    const parsedUrl = parseUrl(req.url || '', true);
    const pathname = parsedUrl.pathname || '/';
    const method = (req.method || 'GET').toUpperCase();

    // 1. Handle API Requests
    // We look for /api/ in the path. This supports mounting with prefixes.
    const apiIndex = pathname.lastIndexOf('/api/');
    if (apiIndex !== -1) {
        const apiPath = pathname.substring(apiIndex); // e.g. /api/reactive/list

        try {
            if (method === 'GET' && apiPath === '/api/reactive/list') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result = await controller.getReactiveTasks(parsedUrl.query as Record<string, any>);
                return sendJson(res, result);
            }

            if (method === 'POST' && apiPath === '/api/reactive/retry') {
                const body = await getBody(req);
                const result = await controller.retryReactiveTasks(body);
                return sendJson(res, result);
            }

            if (method === 'GET' && apiPath === '/api/cron/list') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const result = await controller.getCronTasks(parsedUrl.query as Record<string, any>);
                return sendJson(res, result);
            }

            if (method === 'POST' && apiPath === '/api/cron/trigger') {
                const body = await getBody(req);
                const result = await controller.triggerCronTask(body as { taskId: string });
                return sendJson(res, result);
            }

            if (method === 'GET' && apiPath === '/api/info') {
                const result = await controller.getInfo();
                return sendJson(res, result);
            }

            // If it matched /api/ but no handler, we continue to check for static files
            // (e.g. if the base path itself contains /api/)
            // return false;
        } catch (err) {
            return sendError(res, err);
        }
    }

    // 2. Handle Static Files
    if (method === 'GET' && fs.existsSync(dashboardPath)) {
        // We need to decide which part of pathname is the file.
        // If mounted at /dash, pathname might be /dash/assets/log.png
        // We try to find the file from the end of the pathname.
        // Brute force: try suffixes? No, too slow.
        // Better: The dashboard is a single-file build or limited assets.
        // We can check if the pathname (or parts of it) exist in dashboardPath.

        const pathParts = pathname.split('/').filter(Boolean);
        const root = path.resolve(dashboardPath);
        // Reject path-traversal attempts outright: `parseUrl` does not normalize
        // `..` segments, so without this a request like
        // `/dashboard/../../../../etc/passwd` would escape the dashboard root and
        // disclose arbitrary process-readable files.
        if (!pathParts.includes('..')) {
            // Try suffixes from longest to shortest
            for (let i = 0; i < pathParts.length; i++) {
                const potentialFile = pathParts.slice(i).join('/');
                const filePath = path.resolve(root, potentialFile);
                // Defense in depth: the resolved path must stay inside the root.
                if (filePath !== root && !filePath.startsWith(root + path.sep)) {
                    continue;
                }
                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    return pipeFile(res, filePath);
                }
            }
        }

        // 3. SPA Fallback
        // If it's a GET request and no file found, and it looks like a dashboard route (no extension)
        const lastPart = pathParts[pathParts.length - 1] || '';
        if (!lastPart.includes('.') || pathname.endsWith('/')) {
            const indexPath = path.join(dashboardPath, 'index.html');
            if (fs.existsSync(indexPath)) {
                return pipeFile(res, indexPath);
            }
        }
    }

    return false;
}

/** Error carrying the HTTP status {@link sendError} should report. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
    return Object.assign(new Error(message), { statusCode });
}

async function getBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    // If body is already parsed (Express/Koa with body-parser)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((req as any).body) return (req as any).body;

    return new Promise((resolve, reject) => {
        // Cap the buffered body. Without a limit an attacker (the dashboard has
        // no built-in auth) can stream an unbounded body and exhaust the heap,
        // OOM-killing the whole host application.
        const maxBodyBytes = 1_000_000; // 1 MB
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;

        req.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > maxBodyBytes) {
                settled = true;
                chunks.length = 0; // release what we buffered
                // Pause rather than destroy: destroying here would tear down the
                // socket before the caller can write the 413 response. Node
                // closes the connection itself once we reply without having
                // consumed the request.
                req.pause();
                reject(httpError(413, 'Request body too large'));
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        // A client abort emits neither 'end' nor (reliably) 'error'; without
        // this the promise stays pending and the request handler leaks.
        req.on('close', () => {
            if (settled) return;
            settled = true;
            reject(httpError(400, 'Request aborted before the body was received'));
        });
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendJson(res: ServerResponse, data: any): boolean {
    if (!res.headersSent) {
        res.statusCode = 200;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return true;
}

function sendError(res: ServerResponse, err: unknown): boolean {
    res.statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return true;
}

function pipeFile(res: ServerResponse, filePath: string): boolean {
    if (!res.headersSent) {
        res.statusCode = 200;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    const stream = fs.createReadStream(filePath);
    // .pipe() does not forward source errors; an unhandled 'error' on the read
    // stream (EMFILE, file removed after statSync, EACCES) would otherwise throw
    // an uncaughtException and crash the whole process.
    stream.on('error', () => {
        if (res.headersSent) {
            // Part of the body is already on the wire; ending cleanly here would
            // present a truncated file as a complete one. Destroy so the client
            // sees the transfer fail.
            res.destroy();
            return;
        }
        res.statusCode = 500;
        res.end();
    });
    stream.pipe(res);
    return true;
}

let cachedDashboardPath: string | undefined;

function getResolvedDashboardPath(): string {
    if (cachedDashboardPath) return cachedDashboardPath;

    // In development (ts-node from src), __dirname is src/task-management.
    // We want ../../dist/dashboard.
    const devPath = path.resolve(__dirname, '../../dist/dashboard');

    // In production (compiled JS in dist/lib), __dirname is dist/lib/task-management.
    // ../../dist/dashboard would resolve to dist/dist/dashboard, which is wrong.
    // We want ../../dashboard (which resolves to dist/dashboard).

    if (fs.existsSync(devPath)) {
        cachedDashboardPath = devPath;
    } else {
        cachedDashboardPath = path.resolve(__dirname, '../../dashboard');
    }
    return cachedDashboardPath;
}
