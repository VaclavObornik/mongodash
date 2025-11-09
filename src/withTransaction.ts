'use strict';

import { ClientSession, TransactionOptions } from 'mongodb';
import { getMongoClient } from './getMongoClient';
import { OnError } from './OnError';
import { OnInfo } from './OnInfo';

export type InitOptions = {
    onError: OnError;
    onInfo: OnInfo;
};

export type PostCommitHook = () => void | Promise<void>;

const postCommitHooks = new WeakMap<ClientSession, PostCommitHook[]>();
let _onError: OnError;
let _onInfo: OnInfo;

export function init(options: InitOptions): void {
    _onError = options.onError;
    _onInfo = options.onInfo;
}

export function registerPostCommitHook(session: ClientSession, hook: PostCommitHook): void {
    if (!session.inTransaction()) {
        throw new Error('It is not possible to register a post commit hook without active transaction.');
    }

    const hooks = postCommitHooks.get(session);

    if (!hooks) {
        throw new Error("Post-commit hooks can be registered only for sessions created by mongodash's withTransaction function.");
    }

    hooks.push(hook);
}

export async function withTransaction<T>(callback: (session: ClientSession) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const clientSession = getMongoClient().startSession();

    postCommitHooks.set(clientSession, []);

    try {
        let returnValue: T;

        await clientSession.withTransaction(async () => {
            returnValue = await callback(clientSession);
        }, options);

        const hooks = postCommitHooks.get(clientSession)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

        if (hooks.length > 0) {
            const results = await Promise.allSettled(hooks.map((hook) => hook()));
            results.forEach((result) => {
                if (result.status === 'rejected') {
                    _onError(result.reason);
                }
            });
        }

        return returnValue!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
    } finally {
        postCommitHooks.delete(clientSession);
        await clientSession.endSession();
    }
}
