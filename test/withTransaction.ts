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

    describe('Post-commit hooks', () => {
        it('should execute a single post-commit hook after transaction commits', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            const hookSpy = sandbox.spy();

            await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                registerPostCommitHook(session, hookSpy);
            });

            assert.strictEqual(hookSpy.callCount, 1, 'Post-commit hook should be called exactly once');
            assert.strictEqual(await collection.countDocuments(), 1, 'Transaction should be committed');
        });

        it('should execute multiple post-commit hooks in order', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            const executionOrder: number[] = [];

            const hook1 = sandbox.spy(async () => {
                executionOrder.push(1);
            });
            const hook2 = sandbox.spy(async () => {
                executionOrder.push(2);
            });
            const hook3 = sandbox.spy(async () => {
                executionOrder.push(3);
            });

            await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                registerPostCommitHook(session, hook1);
                registerPostCommitHook(session, hook2);
                registerPostCommitHook(session, hook3);
            });

            assert.strictEqual(hook1.callCount, 1);
            assert.strictEqual(hook2.callCount, 1);
            assert.strictEqual(hook3.callCount, 1);
            assert.deepStrictEqual(executionOrder, [1, 2, 3], 'Hooks should execute in registration order');
        });

        it('should execute async post-commit hooks', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            let hookExecuted = false;

            await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                registerPostCommitHook(session, async () => {
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    hookExecuted = true;
                });
            });

            assert.strictEqual(hookExecuted, true, 'Async hook should be awaited and executed');
            assert.strictEqual(await collection.countDocuments(), 1);
        });

        it('should not execute post-commit hooks if transaction is aborted', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            const hookSpy = sandbox.spy();

            await assert.rejects(
                () =>
                    withTransaction(async (session: ClientSession) => {
                        await collection.insertOne({ val: 1 }, { session });
                        registerPostCommitHook(session, hookSpy);
                        throw new Error('Transaction failed');
                    }),
                /Transaction failed/,
            );

            assert.strictEqual(hookSpy.callCount, 0, 'Post-commit hook should not be called when transaction is aborted');
            assert.strictEqual(await collection.countDocuments(), 0, 'Transaction should be rolled back');
        });

        it('should handle errors in post-commit hooks without affecting transaction result', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            const successHookSpy = sandbox.spy();

            const expectedReturnValue = 'success';
            const hookError = new Error('Hook failed');

            const result = await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                registerPostCommitHook(session, async () => {
                    throw hookError;
                });
                registerPostCommitHook(session, successHookSpy);
                return expectedReturnValue;
            });

            assert.strictEqual(result, expectedReturnValue, 'Transaction should return expected value despite hook error');
            assert.strictEqual(await collection.countDocuments(), 1, 'Transaction should be committed');
            assert.strictEqual(successHookSpy.callCount, 1, 'Other hooks should still execute');
        });

        it('should throw error when registering hook on non-mongodash session', async () => {
            const { registerPostCommitHook, getMongoClient } = instance.mongodash;

            const session = getMongoClient().startSession();

            try {
                assert.throws(() => registerPostCommitHook(session, noop), /It is not possible to register a post commit hook without active transaction/);
            } finally {
                await session.endSession();
            }
        });

        it('should throw error when registering hook outside of active transaction', async () => {
            const { registerPostCommitHook, getMongoClient } = instance.mongodash;
            const collection = await getMongoClient().db().createCollection('transactionTests');
            const session = getMongoClient().startSession();

            try {
                session.startTransaction();
                await collection.insertOne({ val: 1 }, { session });
                await session.commitTransaction();

                assert.throws(() => registerPostCommitHook(session, noop), /It is not possible to register a post commit hook without active transaction/);
            } finally {
                await session.endSession();
            }
        });

        it('should execute hooks only once even with multiple documents', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;
            const collection = await getMongoClient().db().createCollection('transactionTests');
            const hookSpy = sandbox.spy();

            await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                await collection.insertOne({ val: 2 }, { session });
                await collection.insertOne({ val: 3 }, { session });
                registerPostCommitHook(session, hookSpy);
            });

            assert.strictEqual(hookSpy.callCount, 1, 'Hook should be called exactly once');
            assert.strictEqual(await collection.countDocuments(), 3, 'All documents should be inserted');
        });

        it('should handle synchronous post-commit hooks', async () => {
            const { withTransaction, registerPostCommitHook, getMongoClient } = instance.mongodash;

            const collection = await getMongoClient().db().createCollection('transactionTests');
            let hookExecuted = false;

            await withTransaction(async (session: ClientSession) => {
                await collection.insertOne({ val: 1 }, { session });
                registerPostCommitHook(session, () => {
                    hookExecuted = true;
                });
            });

            assert.strictEqual(hookExecuted, true, 'Synchronous hook should be executed');
            assert.strictEqual(await collection.countDocuments(), 1);
        });
    });
});
