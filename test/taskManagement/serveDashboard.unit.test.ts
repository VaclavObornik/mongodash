import { IncomingMessage, ServerResponse } from 'http';
import { getNewInstance } from '../testHelpers';

// Mock fs only
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    statSync: jest.fn(),
    createReadStream: jest.fn(),
}));

describe('serveDashboard Integration Tests', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let serveDashboard: any;
    let API: typeof instance.mongodash;
    let req: Partial<IncomingMessage>;
    let res: Partial<ServerResponse>;
    let endSpy: jest.Mock;
    let writeSpy: jest.Mock;
    let setHeaderSpy: jest.Mock;

    let fsMock: any;

    beforeEach(async () => {
        jest.resetModules();
        instance = getNewInstance();

        serveDashboard = require('../../src/task-management/serveDashboard').serveDashboard;

        fsMock = require('fs'); // Get the fresh fs mock after resetModules

        await instance.initInstance();
        API = instance.mongodash;

        // Initialize real controller (needed for setup?) - actually we pass scheduler
        const scheduler = (API as any)._scheduler;
        if (!scheduler) throw new Error('Scheduler not initialized');
        if (!serveDashboard) throw new Error('serveDashboard not loaded');

        // Setup Req/Res mocks
        req = {
            url: '/',
            method: 'GET',
            on: jest.fn(),
        };

        endSpy = jest.fn();
        writeSpy = jest.fn();
        setHeaderSpy = jest.fn();

        res = {
            end: endSpy,
            write: writeSpy,
            setHeader: setHeaderSpy,
            statusCode: 404,
        };

        // Reset fs mocks
        jest.clearAllMocks();
        if (fsMock) (fsMock.existsSync as jest.Mock).mockReturnValue(false);
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const emitBody = (body: any) => {
        const on = req.on as jest.Mock;
        const dataHandler = on.mock.calls.find((call) => call[0] === 'data')?.[1];
        const endHandler = on.mock.calls.find((call) => call[0] === 'end')?.[1];

        if (dataHandler) dataHandler(JSON.stringify(body));
        if (endHandler) endHandler();
    };

    describe('API Routing (Real Integration)', () => {
        // const scheduler = (API as any)._scheduler; // Accessing here is too early!

        it('should handle /api/reactive/list', async () => {
            const scheduler = (API as any)._scheduler;
            req.url = '/api/reactive/list?status=failed';
            await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            expect(res.statusCode).toBe(200);
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.items).toBeDefined();
            expect(Array.isArray(response.items)).toBe(true);
        });

        it('should handle /api/reactive/retry (POST)', async () => {
            req.url = '/api/reactive/retry';
            req.method = 'POST';

            const scheduler = (API as any)._scheduler;
            const p = serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });
            emitBody({ taskId: 'some-task' });
            await p;

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            if (response.error) {
                expect(response.error).toContain('not found');
            } else {
                expect(response.modifiedCount).toBeDefined();
            }
        });

        it('should handle /api/cron/list', async () => {
            const scheduler = (API as any)._scheduler;
            req.url = '/api/cron/list';
            await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.items).toBeDefined();
        });

        it('should handle /api/cron/trigger (POST)', async () => {
            req.url = '/api/cron/trigger';
            req.method = 'POST';

            const scheduler = (API as any)._scheduler;
            const p = serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });
            emitBody({ taskId: 'cron-task-1' });
            await p;

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.error).toBeDefined();
        });

        it('should handle /api/info', async () => {
            const scheduler = (API as any)._scheduler;
            req.url = '/api/info';
            await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.databaseName).toBeDefined();
            expect(response.reactiveTasks).toBeDefined();
            expect(response.cronTasks).toBeDefined();
        });

        it('should handle unknown API route', async () => {
            const scheduler = (API as any)._scheduler;
            req.url = '/api/unknown';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });
            expect(handled).toBe(false);
        });

        it('should handle nested API route (e.g. mounted under /api/utils)', async () => {
            const scheduler = (API as any)._scheduler;
            // Simulating mount at /api/utils/taskDashboard
            req.url = '/api/utils/taskDashboard/api/reactive/list?status=failed';
            await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.items).toBeDefined();
            expect(Array.isArray(response.items)).toBe(true);
        });

        it('should handle API call when path itself contains /api/ (double nested)', async () => {
            const scheduler = (API as any)._scheduler;
            // Like: /api/utils/taskDashboard/api/info
            req.url = '/api/utils/taskDashboard/api/info';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

            expect(handled).toBe(true);
            expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'application/json');
            // verify it matches info response structure
            const response = JSON.parse(endSpy.mock.calls[0][0]);
            expect(response.databaseName).toBeDefined();
        });
    });

    describe('Static File Serving', () => {
        const dashboardPath = '/mock/dist';
        // const scheduler = (API as any)._scheduler; // Premature

        it('should serve exact file match', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/style.css');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

            req.url = '/style.css';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/style.css');
            expect(res.statusCode).toBe(200);
        });

        it('should serve index.html via SPA fallback', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/index.html');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

            req.url = '/some/route';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/index.html');
        });

        it('should serve exact file with nested path containing "api"', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/style.css');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

            // Mounted at /api/utils/dashboard
            req.url = '/api/utils/dashboard/style.css';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/style.css');
        });

        it('should serve index.html via SPA fallback with nested path containing "api"', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/index.html');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

            // Mounted at /api/utils/dashboard
            req.url = '/api/utils/dashboard/view/123';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/index.html');
        });
        describe('Path Resolution', () => {
            // We need to access the helper but it's internal.
            // But we can verify it by checking what path it tries to read.
            // Note: fsMock is reset in beforeEach so we mock it per test.

            it('should use dev path (dist/dashboard) if it exists', async () => {
                const scheduler = (API as any)._scheduler;

                // Mock that ../../dist/dashboard exists (The "Dev" path relative to src/task-management)
                // AND that ../../dashboard also "exists" but shouldn't be picked if dev path is found first?
                // Actually the logic prefers dev path if it exists.

                // We can't easily guess the absolute path __dirname resolves to in the test env without `path`.
                // But we can match endsWith.
                (fsMock.existsSync as jest.Mock).mockImplementation((p: string) => {
                    return p.endsWith('dist/dashboard') || p.endsWith('style.css');
                });
                (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
                (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

                req.url = '/style.css';
                const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler }); // No explicit dashboardPath

                expect(handled).toBe(true);
                const callArgs = (fsMock.createReadStream as jest.Mock).mock.calls[0][0];
                expect(callArgs).toMatch(/dist\/dashboard\/style\.css$/);
            });

            it('should fallback to prod path (root dashboard) if dev path missing', async () => {
                const scheduler = (API as any)._scheduler;

                (fsMock.existsSync as jest.Mock).mockImplementation((p: string) => {
                    // Return FALSE for dist/dashboard (simulating dist/dist issue)
                    if (p.endsWith('dist/dashboard')) return false;

                    // Return TRUE for root dashboard
                    return p.endsWith('/dashboard') || p.endsWith('style.css');
                });
                (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
                (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn(), on: jest.fn() });

                req.url = '/style.css';
                const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler });

                expect(handled).toBe(true);
                const callArgs = (fsMock.createReadStream as jest.Mock).mock.calls[0][0];
                expect(callArgs).toMatch(/\/dashboard\/style\.css$/);
                expect(callArgs).not.toMatch(/dist\/dashboard\/style\.css$/);
            });
        });
    });
});
