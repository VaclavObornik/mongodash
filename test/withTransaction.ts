/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import { noop } from 'lodash';
import { ClientSession } from 'mongodb';
import { createSandbox, SinonStub } from 'sinon';
import { getNewInstance } from './testHelpers';

describe('withTransaction', () => {
    if ('MONGODB_VERSION' in process.env && (process.env.MONGODB_VERSION as string) < '4.0') {
        it.skip('NOT SUITABLE MONGODB_VERSION', noop);
        return;
    }

    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
    });
    afterEach(() => instance.cleanUpInstance());

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should be possible to perform a transaction and get returned value', async () => {
        const { withTransaction, getMongoClient } = instance.mongodash;
        const expectedReturnValue = 1000;

        // because collections cannot be created in transactions
        const collection = await getMongoClient().db().createCollection('transactionTests');
        let _session: ClientSession;

        let abortTransaction: SinonStub;
        let endSession: SinonStub;

        const returnValue = await withTransaction(async (session: ClientSession) => {
            assert.strictEqual(session.constructor.name, 'ClientSession');
            assert(session.inTransaction());
            _session = session;
            abortTransaction = sandbox.stub(session, 'abortTransaction').callThrough();
            endSession = sandbox.stub(session, 'endSession').callThrough();
            await collection.insertOne({ val: 1 }, { session });
            await collection.insertOne({ val: 1 }, { session });
            return expectedReturnValue;
        });

        assert(!_session!.inTransaction());
        assert.strictEqual(endSession!.callCount, 1);
        assert.strictEqual(abortTransaction!.callCount, 0);
        assert.strictEqual(returnValue, expectedReturnValue, "The withTransaction should propagate callback's return value.");
        assert.strictEqual(await collection.countDocuments(), 2);
    });

    it('should abort transaction and throw the error in case of failure', async () => {
        const { withTransaction, getMongoClient } = instance.mongodash;

        // because collections cannot be created in transactions
        const collection = await getMongoClient().db().createCollection('transactionTests');
        let _session: ClientSession;

        let abortTransaction: SinonStub;
        let endSession: SinonStub;

        const error = new Error('Some Error');

        await assert.rejects(
            () =>
                withTransaction(async (session: ClientSession) => {
                    _session = session;
                    abortTransaction = sandbox.stub(session, 'abortTransaction').callThrough();
                    endSession = sandbox.stub(session, 'endSession').callThrough();
                    await collection.insertOne({ val: 1 }, { session });
                    await collection.insertOne({ val: 1 }, { session });

                    throw error;
                }),
            /Some Error/,
            'The Some Error expected to be rejected',
        );

        assert(!_session!.inTransaction());
        assert.strictEqual(abortTransaction!.callCount, 1); // automatically called by native withTransaction function
        assert.strictEqual(endSession!.callCount, 1);
        assert(abortTransaction!.calledBefore(endSession!));
        assert.strictEqual(await collection.countDocuments(), 0);
    });
});
