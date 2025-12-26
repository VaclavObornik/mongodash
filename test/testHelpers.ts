import * as _debug from 'debug';
import { noop } from 'lodash';
import { Collection } from 'mongodb';
import * as Mongodash from '../src';
import { InitOptions, OnError } from '../src';
const { getConnectionString, cleanTestingDatabases } = require('../tools/testingDatabase');

const debug = _debug('mongodash:testHelpers');

export function getNewInstance() {
    debug('getNewInstance');
    jest.resetModules();
    const mongodash = require('../src');

    let _onError: OnError = noop;

    function setOnError(onError: OnError): void {
        _onError = onError;
    }

    const collectionCalls: { [key: string]: number } = {};

    const usedCollections: { [key: string]: Collection } = {};

    const initInstance = async (initOptions: Partial<InitOptions> = {}, skipClean = false) => {
        debug('initInstance');
        if (!skipClean) {
            await cleanTestingDatabases();
        }

        try {
            await mongodash.init({
                uri: getConnectionString(),

                onError: (error: Error) => _onError(error),

                // will serve single instances of collections during the tests so we can get
                // the same instances in test and manipulate with them using sinon
                collectionFactory: (name: string) => {
                    if (!(name in usedCollections)) {
                        usedCollections[name] = mongodash.getCollection(name);
                    }
                    collectionCalls[name] = (collectionCalls[name] || 0) + 1;
                    return usedCollections[name];
                },

                ...initOptions,
            });
            debug('initInstance done');
        } catch (e) {
            console.error('initInstance failed:', e);
            throw e;
        }
    };
    const cleanUpInstance = async () => {
        debug('cleanUpInstance');
        try {
            mongodash.stopCronTasks();
            await mongodash.stopReactiveTasks();
            await mongodash.getMongoClient().close();
        } catch (e) {
            // Ignore errors if instance wasn't initialized
            debug('cleanUpInstance warning:', e);
        }
    };

    return {
        cleanUpInstance,
        setOnError,
        collectionCalls,
        mongodash: mongodash as typeof Mongodash,
        initInstance,
    };
}

export async function wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Waits until a predicate returns true or timeout expires.
 * Uses polling with configurable interval.
 *
 * @param predicate - Function that returns true when condition is met (can be async).
 * @param options - Configuration options.
 * @returns The value that satisfied the predicate.
 * @throws Error if timeout expires before predicate returns true.
 *
 * @example
 * // Wait for a task to complete
 * await waitUntil(async () => {
 *   const task = await collection.findOne({ _id: taskId });
 *   return task?.status === 'completed';
 * });
 */
export async function waitUntil<T>(
    predicate: () => T | Promise<T>,
    options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<NonNullable<T>> {
    const { timeoutMs = 5000, intervalMs = 100, message = 'Condition not met' } = options;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const result = await predicate();
        if (result) {
            return result as NonNullable<T>;
        }
        await wait(intervalMs);
    }

    throw new Error(`waitUntil timeout (${timeoutMs}ms): ${message}`);
}

export type Instance = ReturnType<typeof getNewInstance>;

/**
 * Creates a stub that can be waited for REPEATEDLY
 * and which also calls the original function.
 *
 * @param {Function} [originalFunction] - Original function to call.
 * @param {number} [defaultTimeoutMs=5000] - Default timeout.
 * @returns {{
 * stub: sinon.SinonStub,
 * waitForNextCall: (timeoutMs?: number) => Promise<any[]>
 * }}
 */
export function createReusableWaitableStub(originalFunction = noop, defaultTimeoutMs = 5000) {
    // Queue for calls that happened but no one was waiting for them.
    const callArgsBuffer: any[][] = [];

    // Queue for "waiters" (await) waiting for future calls.
    // We store the { resolve, reject } object for each Promise.
    const waiterPromiseResolvers: Array<{ resolve: (value: any[]) => void; reject: (reason?: any) => void }> = [];

    // 1. STUB (Producent)
    const stub = require('sinon').stub();
    stub.callsFake(function (this: any, ...args: any[]) {
        // Je někdo ve frontě čekatelů?
        if (waiterPromiseResolvers.length > 0) {
            // Ano. Vezmeme prvního čekatele z fronty
            const waiter = waiterPromiseResolvers.shift();
            // a splníme jeho Promise s aktuálními argumenty.
            if (waiter) {
                waiter.resolve(args);
            }
        } else {
            // No. No one is waiting. Store arguments in buffer for later use.
            console.log('Stub called, buffering args:', args);
            callArgsBuffer.push(args);
        }

        // And of course call the original function
        return originalFunction.apply(this, args);
    });

    // Helper to wait for call or timeout
    const waitForCallOrTimeout = (timeoutMs: number): Promise<{ type: 'call'; args: any[] } | { type: 'timeout' }> => {
        return new Promise((resolve) => {
            let waiter: { resolve: (value: any[]) => void; reject: (reason?: any) => void };

            // Wait for potential future call
            const waitPromise = new Promise<any[]>((res) => {
                waiter = { resolve: res, reject: noop }; // reject is not used here
                waiterPromiseResolvers.push(waiter);
            });

            // Wait for timeout
            const timeoutPromise = new Promise<void>((res) => {
                setTimeout(() => {
                    // Remove waiter
                    const index = waiterPromiseResolvers.indexOf(waiter);
                    if (index > -1) {
                        waiterPromiseResolvers.splice(index, 1);
                    }
                    res();
                }, timeoutMs);
            });

            // Race them
            waitPromise.then((args) => resolve({ type: 'call', args }));
            timeoutPromise.then(() => resolve({ type: 'timeout' }));
        });
    };

    // 2. WAIT FUNCTION (Consumer)
    const waitForNextCall = async (timeoutMs = defaultTimeoutMs) => {
        // Is there anything in the call buffer?
        if (callArgsBuffer.length > 0) {
            return callArgsBuffer.shift() || [];
        }

        const result = await waitForCallOrTimeout(timeoutMs);
        if (result.type === 'call') {
            return result.args;
        } else {
            throw new Error(`Timeout ${timeoutMs}ms expired while waiting for next call.`);
        }
    };

    // 3. EXPECT NO CALL FUNCTION
    const expectNoCall = async (timeoutMs: number) => {
        // Check buffer first
        if (callArgsBuffer.length > 0) {
            throw new Error(`Expected no call, but stub was called with: ${JSON.stringify(callArgsBuffer[0])}`);
        }

        const result = await waitForCallOrTimeout(timeoutMs);
        if (result.type === 'call') {
            throw new Error(`Expected no call, but stub was called with: ${JSON.stringify(result.args)}`);
        }
        // Timeout means success (no call happened)
    };

    return {
        stub,
        waitForNextCall,
        expectNoCall,
    };
}
