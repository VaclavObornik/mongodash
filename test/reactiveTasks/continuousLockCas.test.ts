import { Collection, ObjectId } from 'mongodb';
import { createContinuousLock } from '../../src/createContinuousLock';
import { getNewInstance, wait } from '../testHelpers';

/**
 * Covers the opt-in CAS mode of createContinuousLock added in Iter 2.
 * Without CAS, a slow worker whose lock expires would keep overwriting the
 * new claimant's lock value during background renewal. With CAS, we detect
 * the loss and call onLockLost.
 */
describe('createContinuousLock - CAS mode', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let collection: Collection<{ _id: ObjectId; lockUntil: Date | null }>;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
        collection = instance.mongodash.getCollection('continuous_lock_cas_test') as unknown as Collection<{
            _id: ObjectId;
            lockUntil: Date | null;
        }>;
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('keeps renewing when nobody else touches the lock (CAS succeeds)', async () => {
        const id = new ObjectId();
        const initial = new Date(Date.now() + 100);
        await collection.insertOne({ _id: id, lockUntil: initial });

        const stop = createContinuousLock(collection, id, 'lockUntil', 100, {
            expectedInitialValue: initial,
        });

        await wait(250); // at least 2 renewals at 20ms intervals

        const after = await collection.findOne({ _id: id });
        expect(after?.lockUntil).toBeTruthy();
        expect(after!.lockUntil!.getTime()).toBeGreaterThan(initial.getTime());

        await stop();
    });

    it('stops renewing and fires onLockLost when a third party overwrites the lock', async () => {
        const id = new ObjectId();
        const initial = new Date(Date.now() + 200);
        await collection.insertOne({ _id: id, lockUntil: initial });

        let lockLost = 0;
        const stop = createContinuousLock(collection, id, 'lockUntil', 200, {
            expectedInitialValue: initial,
            onLockLost: () => {
                lockLost += 1;
            },
        });

        // Simulate another worker claiming the lock.
        const stolenAt = new Date(Date.now() + 5000);
        await collection.updateOne({ _id: id }, { $set: { lockUntil: stolenAt } });

        // Wait past the next renewal tick.
        await wait(150);

        const after = await collection.findOne({ _id: id });
        // CAS renewal must have left the third-party value intact.
        expect(after?.lockUntil?.getTime()).toBe(stolenAt.getTime());
        expect(lockLost).toBe(1);

        // onLockLost should not fire again even after waiting further.
        await wait(150);
        expect(lockLost).toBe(1);

        await stop();
    });

    it('is BC: without expectedInitialValue, behaves like the previous version', async () => {
        const id = new ObjectId();
        await collection.insertOne({ _id: id, lockUntil: new Date(Date.now() + 100) });

        let lockLost = 0;
        const stop = createContinuousLock(collection, id, 'lockUntil', 100, {
            onLockLost: () => {
                lockLost += 1;
            },
        });

        // Even if someone else rewrites the lock, the non-CAS path keeps
        // renewing unconditionally.
        await collection.updateOne({ _id: id }, { $set: { lockUntil: new Date(Date.now() + 1_000_000) } });
        await wait(150);

        expect(lockLost).toBe(0);
        await stop();
    });
});
