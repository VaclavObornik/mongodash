'use strict';

// import { ClientSession, TransactionOptions } from 'mongodb'; // TransactionOptions is unused?
// If TransactionOptions is unused, I should remove it.
import { ClientSession } from 'mongodb';
import { getMongoClient } from './getMongoClient';
import { onError } from './OnError';

export type PostCommitHook = () => void | Promise<void>;

const postCommitHooks = new WeakMap<ClientSession, PostCommitHook[]>();

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

export async function withTransaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
    const clientSession = getMongoClient().startSession();

    postCommitHooks.set(clientSession, []);

    try {
        let returnValue: T;

        await clientSession.withTransaction(async () => {
            returnValue = await callback(clientSession);
        });

        const hooks = postCommitHooks.get(clientSession)!;

        if (hooks.length > 0) {
            const results = await Promise.allSettled(hooks.map((hook) => hook()));
            results.forEach((result) => {
                if (result.status === 'rejected') {
                    onError(result.reason);
                }
            });
        }

        return returnValue!;
    } finally {
        postCommitHooks.delete(clientSession);
        await clientSession.endSession();
    }
}
