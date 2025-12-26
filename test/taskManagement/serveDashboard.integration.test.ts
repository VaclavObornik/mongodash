import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { init, serveDashboard } from '../../src/index';

const { getConnectionString } = require('../../tools/testingDatabase');

describe('serveDashboard Integration', () => {
    beforeAll(async () => {
        try {
            await init({
                uri: getConnectionString(),
                runCronTasks: false,
            });
        } catch {
            // Might be already initialized by other tests
        }
    });

    it('should handle native Node.js http request', async () => {
        const req = {
            url: '/api/reactive/list',
            method: 'GET',
            on: () => {},
        } as any;

        let headerSet = false;
        let bodyEnded = false;
        const res = {
            setHeader: () => {
                headerSet = true;
            },
            end: () => {
                bodyEnded = true;
            },
        } as any;

        const handled = await serveDashboard(req, res);
        assert.strictEqual(handled, true);
        assert.strictEqual(headerSet, true);
        assert.strictEqual(bodyEnded, true);
    });

    it('should handle Express-style request with prefix', async () => {
        const req = {
            url: '/admin/dashboard/api/cron/list',
            method: 'GET',
        } as any;

        let resData = '';
        const res = {
            setHeader: () => {},
            end: (data: string) => {
                resData = data;
            },
        } as any;

        const handled = await serveDashboard(req, res);
        assert.strictEqual(handled, true);
        assert.ok(resData.includes('"items"'));
    });

    it('should handle Koa-style request (ctx.req, ctx.res)', async () => {
        const ctx = {
            req: {
                url: '/tasks/api/reactive/list',
                method: 'GET',
            },
            res: {
                setHeader: () => {},
                end: () => {},
            },
        } as any;

        const handled = await serveDashboard(ctx.req, ctx.res);
        assert.strictEqual(handled, true);
    });

    it('should fall back to index.html for unknown routes (SPA)', async () => {
        const tempPath = path.join(__dirname, 'temp-dash');
        if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
        fs.writeFileSync(path.join(tempPath, 'index.html'), '<html><body>Dashboard</body></html>');

        const req = {
            url: '/admin/dashboard/some-route',
            method: 'GET',
        } as any;

        let resContent = '';
        let resolveDone: (v: void) => void;
        const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
        });

        const res = {
            setHeader: () => {},
            write: (chunk: Buffer | string) => {
                resContent += chunk.toString();
            },
            on: () => {},
            once: () => {},
            emit: () => {},
            destroy: () => {},
            end: (data?: string) => {
                if (data) resContent += data;
                resolveDone();
            },
            writable: true,
        } as any;
        const handled = await serveDashboard(req, res, { dashboardPath: tempPath });

        assert.strictEqual(handled, true);
        await done;
        assert.strictEqual(resContent, '<html><body>Dashboard</body></html>');

        // Cleanup
        fs.unlinkSync(path.join(tempPath, 'index.html'));
        fs.rmdirSync(tempPath);
    });

    it('should return false for completely non-matching paths', async () => {
        const req = {
            url: '/other-app/some-path',
            method: 'GET',
        } as any;
        const res = {} as any;
        const handled = await serveDashboard(req, res, { dashboardPath: '/non-existent-path-for-test' });
        assert.strictEqual(handled, false);
    });
});
