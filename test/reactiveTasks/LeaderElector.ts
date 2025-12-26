import createDebug from 'debug';
import { noop } from 'lodash';
import * as sinon from 'sinon';
import { createSandbox } from 'sinon';
import { GlobalsCollection } from '../../src/globalsCollection';
import { LeaderElector } from '../../src/reactiveTasks/LeaderElector';
import { REACTIVE_TASK_META_DOC_ID } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';

const _debug = createDebug('mongodash:test:LeaderElector');

describe('LeaderElector', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let globalsCollection: GlobalsCollection;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        globalsCollection = instance.mongodash.getCollection('_mongodash_globals');
        // Ensure clean state
        await globalsCollection.deleteMany({});
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    const createElector = (instanceId: string, callbacks: any = {}, options: any = {}) => {
        const defaultCallbacks = {
            onBecomeLeader: sandbox.stub().resolves(),
            onLoseLeader: sandbox.stub().resolves(),
            onHeartbeat: sandbox.stub().resolves(),
        };
        const defaultOptions = {
            lockTtlMs: 1000,
            lockHeartbeatMs: 200,
            metaDocId: REACTIVE_TASK_META_DOC_ID,
        };

        return new LeaderElector(globalsCollection, instanceId, { ...defaultOptions, ...options }, { ...defaultCallbacks, ...callbacks }, noop, noop);
    };

    it('should acquire lock when free', async () => {
        const callbacks = {
            onBecomeLeader: createReusableWaitableStub().stub,
        };
        const elector = createElector('inst1', callbacks);

        await elector.start();

        // Wait for leader acquisition
        await wait(300);

        expect(elector.isLeader).toBe(true);
        sinon.assert.calledOnce(callbacks.onBecomeLeader);

        const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        expect(metaDoc?.lock?.instanceId).toBe('inst1');

        await elector.stop();
    });

    it('should renew lock periodically (heartbeat)', async () => {
        const callbacks = {
            onHeartbeat: createReusableWaitableStub().stub,
        };
        const elector = createElector('inst1', callbacks, { lockHeartbeatMs: 100, lockTtlMs: 500 });

        await elector.start();
        await wait(200); // Wait for start

        const metaDoc1 = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        const expiresAt1 = metaDoc1?.lock?.expiresAt;

        await wait(200); // Wait for heartbeat

        const metaDoc2 = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        const expiresAt2 = metaDoc2?.lock?.expiresAt;

        expect(expiresAt2.getTime()).toBeGreaterThan(expiresAt1.getTime());
        sinon.assert.called(callbacks.onHeartbeat);

        await elector.stop();
    });

    it('should prevent another instance from acquiring lock while valid', async () => {
        const elector1 = createElector('inst1');
        const elector2 = createElector('inst2');

        await elector1.start();
        await wait(300);
        expect(elector1.isLeader).toBe(true);

        await elector2.start();
        await wait(300);
        expect(elector2.isLeader).toBe(false);

        const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        expect(metaDoc?.lock?.instanceId).toBe('inst1');

        await elector1.stop();
        await elector2.stop();
    });

    it('should steal lock if expired', async () => {
        const elector1 = createElector('inst1', {}, { lockTtlMs: 200, lockHeartbeatMs: 50 }); // Fast expiry
        const elector2 = createElector('inst2', {}, { lockTtlMs: 1000, lockHeartbeatMs: 200 });

        await elector1.start();
        await wait(100);
        expect(elector1.isLeader).toBe(true);

        // Stop elector1 WITHOUT releasing lock (simulate crash)
        // We can't easily simulate crash without modifying code or mocking,
        // but we can just stop the timer and not call release.
        // Or we can just manually expire the lock in DB.
        await elector1.stop(); // This releases lock by default.

        // Let's manually set a lock that is expired
        await globalsCollection.updateOne(
            { _id: REACTIVE_TASK_META_DOC_ID as any },
            {
                $set: {
                    'lock.instanceId': 'crashed_inst',
                    'lock.expiresAt': new Date(Date.now() - 1000),
                },
            },
            { upsert: true },
        );

        await elector2.start();
        await wait(300);

        expect(elector2.isLeader).toBe(true);
        const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        expect(metaDoc?.lock?.instanceId).toBe('inst2');

        await elector2.stop();
    });

    it('should release lock on stop', async () => {
        const elector = createElector('inst1');
        await elector.start();
        await wait(300);
        expect(elector.isLeader).toBe(true);

        await elector.stop();

        const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        expect(metaDoc?.lock).toBeUndefined();
    });

    it('should call onLoseLeader if lock is lost (stolen)', async () => {
        const callbacks = {
            onLoseLeader: createReusableWaitableStub().stub,
        };
        const elector = createElector('inst1', callbacks);
        await elector.start();
        await wait(300);
        expect(elector.isLeader).toBe(true);

        // Simulate another instance stealing the lock (manually update DB)
        await globalsCollection.updateOne(
            { _id: REACTIVE_TASK_META_DOC_ID as any },
            {
                $set: {
                    'lock.instanceId': 'inst2',
                    'lock.expiresAt': new Date(Date.now() + 10000),
                },
            },
        );

        // Wait for next heartbeat where it checks lock
        await wait(300);

        expect(elector.isLeader).toBe(false);
        sinon.assert.calledOnce(callbacks.onLoseLeader);

        await elector.stop();
    });

    it('should force lose leader', async () => {
        const elector = createElector('inst1');
        await elector.start();
        await wait(300);
        expect(elector.isLeader).toBe(true);

        elector.forceLoseLeader();
        expect(elector.isLeader).toBe(false);

        await elector.stop();
    });

    it('should handle errors during lock acquisition', async () => {
        const onError = sandbox.stub();
        const elector = createElector('inst1', {}, {});
        // @ts-ignore - accessing private property for test
        elector.onError = onError;

        // Mock globalsCollection.findOneAndUpdate to throw
        const _originalFindOneAndUpdate = globalsCollection.findOneAndUpdate;
        sandbox.stub(globalsCollection, 'findOneAndUpdate').rejects(new Error('DB Error'));

        await elector.start();
        await wait(300);

        sinon.assert.called(onError);
        expect(elector.isLeader).toBe(false);

        await elector.stop();
        // Restore is handled by sandbox
    });

    it('should handle leader handover between two instances', async () => {
        const elector1 = createElector('inst1');
        const elector2 = createElector('inst2');

        // 1. Start both
        await elector1.start();
        await elector2.start();

        await wait(500);

        // One should be leader
        const leader1 = elector1.isLeader;
        const leader2 = elector2.isLeader;
        expect(leader1 !== leader2).toBe(true); // XOR

        const currentLeader = leader1 ? elector1 : elector2;
        const currentFollower = leader1 ? elector2 : elector1;

        // 2. Stop leader
        await currentLeader.stop();
        await wait(500);

        // 3. Follower should become leader
        expect(currentFollower.isLeader).toBe(true);

        await currentFollower.stop();
    });

    it('should respect lockTtlMs option', async () => {
        const ttl = 5000;
        const elector = createElector('inst1', {}, { lockTtlMs: ttl });
        await elector.start();
        await wait(300);

        const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
        const expiresAt = metaDoc?.lock?.expiresAt;
        const now = new Date();

        // Check if expiry is roughly now + ttl
        const diff = expiresAt.getTime() - now.getTime();
        expect(diff).toBeGreaterThan(ttl - 1000); // Allow some buffer
        expect(diff).toBeLessThanOrEqual(ttl + 1000);

        await elector.stop();
    });

    it('should be idempotent on stop', async () => {
        const elector = createElector('inst1');
        await elector.start();
        await wait(100);

        await elector.stop();
        await expect(elector.stop()).resolves.not.toThrow();
    });

    it('should call onLoseLeader when leader loses due to DB error', async () => {
        const callbacks = {
            onBecomeLeader: sandbox.stub().resolves(),
            onLoseLeader: sandbox.stub().resolves(),
            onHeartbeat: sandbox.stub().resolves(),
        };
        const onError = sandbox.stub();
        const elector = new LeaderElector(
            globalsCollection,
            'inst1',
            { lockTtlMs: 1000, lockHeartbeatMs: 100, metaDocId: REACTIVE_TASK_META_DOC_ID },
            callbacks,
            noop,
            onError,
        );

        await elector.start();
        await wait(200);
        expect(elector.isLeader).toBe(true);

        // Now cause findOneAndUpdate to fail
        sandbox.stub(globalsCollection, 'findOneAndUpdate').rejects(new Error('DB Error after leadership'));

        // Wait for next heartbeat to trigger the error
        await wait(200);

        expect(elector.isLeader).toBe(false);
        sinon.assert.called(onError);
        sinon.assert.calledOnce(callbacks.onLoseLeader);

        await elector.stop();
    });

    it('should handle errors during releaseLock gracefully', async () => {
        const onError = sandbox.stub();
        const elector = new LeaderElector(
            globalsCollection,
            'inst1',
            { lockTtlMs: 1000, lockHeartbeatMs: 100, metaDocId: REACTIVE_TASK_META_DOC_ID },
            {
                onBecomeLeader: sandbox.stub().resolves(),
                onLoseLeader: sandbox.stub().resolves(),
                onHeartbeat: sandbox.stub().resolves(),
            },
            noop,
            onError,
        );

        await elector.start();
        await wait(200);
        expect(elector.isLeader).toBe(true);

        // Stub updateOne to fail (used in releaseLock)
        sandbox.stub(globalsCollection, 'updateOne').rejects(new Error('Release lock failed'));

        // Stop should still complete, error should be passed to onError
        await elector.stop();

        sinon.assert.calledOnce(onError);
        expect(onError.firstCall.args[0].message).toBe('Release lock failed');
    });

    it('should call onError from runLeaderElectionLoop catch block', async () => {
        const callbacks = {
            onBecomeLeader: sandbox.stub().resolves(),
            onLoseLeader: sandbox.stub().resolves(),
            onHeartbeat: sandbox.stub().rejects(new Error('Heartbeat error')),
        };
        const onError = sandbox.stub();
        const elector = new LeaderElector(
            globalsCollection,
            'inst1',
            { lockTtlMs: 1000, lockHeartbeatMs: 100, metaDocId: REACTIVE_TASK_META_DOC_ID },
            callbacks,
            noop,
            onError,
        );

        await elector.start();
        await wait(300);

        // onHeartbeat should have been called and thrown, which should trigger onError
        sinon.assert.called(onError);
        expect(onError.firstCall.args[0].message).toBe('Heartbeat error');

        await elector.stop();
    });
});
