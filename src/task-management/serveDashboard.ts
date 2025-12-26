import * as fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { parse as parseUrl } from 'url';
import { ReactiveTaskScheduler, _scheduler as defaultScheduler } from '../reactiveTasks/index';
import { OperationalTaskController } from './OperationalTaskController';

console.log('[serveDashboard.ts] Module loaded');

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
    const dashboardPath = options.dashboardPath || path.resolve(__dirname, '../../dist/dashboard');

    const parsedUrl = parseUrl(req.url || '', true);
    const pathname = parsedUrl.pathname || '/';
    const method = (req.method || 'GET').toUpperCase();

    // 1. Handle API Requests
    // We look for /api/ in the path. This supports mounting with prefixes.
    const apiIndex = pathname.indexOf('/api/');
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

            // If it matched /api/ but no handler, we return false so parent can handle or 404
            return false;
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
        // Try suffixes from longest to shortest
        for (let i = 0; i < pathParts.length; i++) {
            const potentialFile = pathParts.slice(i).join('/');
            const filePath = path.join(dashboardPath, potentialFile);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return pipeFile(res, filePath);
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

async function getBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    // If body is already parsed (Express/Koa with body-parser)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((req as any).body) return (req as any).body;

    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer | string) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendJson(res: ServerResponse, data: any): boolean {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return true;
}

function sendError(res: ServerResponse, err: unknown): boolean {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return true;
}

function pipeFile(res: ServerResponse, filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    fs.createReadStream(filePath).pipe(res);
    return true;
}
