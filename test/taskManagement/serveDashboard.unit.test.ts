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
            statusCode: 200,
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
    });

    describe('Static File Serving', () => {
        const dashboardPath = '/mock/dist';
        // const scheduler = (API as any)._scheduler; // Premature

        it('should serve exact file match', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/style.css');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn() });

            req.url = '/style.css';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/style.css');
        });

        it('should serve index.html via SPA fallback', async () => {
            const scheduler = (API as any)._scheduler;
            (fsMock.existsSync as jest.Mock).mockImplementation((p) => p === '/mock/dist' || p === '/mock/dist/index.html');
            (fsMock.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
            (fsMock.createReadStream as jest.Mock).mockReturnValue({ pipe: jest.fn() });

            req.url = '/some/route';
            const handled = await serveDashboard(req as IncomingMessage, res as ServerResponse, { scheduler, dashboardPath });
            expect(handled).toBe(true);
            expect(fsMock.createReadStream).toHaveBeenCalledWith('/mock/dist/index.html');
        });
    });
});
