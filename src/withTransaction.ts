'use strict';

import { ClientSession, TransactionOptions } from 'mongodb';
import { getMongoClient } from './getMongoClient';

export async function withTransaction<T>(callback: (session: ClientSession) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const clientSession = getMongoClient().startSession();

    try {
        let returnValue: T;

        await clientSession.withTransaction(async () => {
            returnValue = await callback(clientSession);
        }, options);

        return returnValue!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
    } finally {
        await clientSession.endSession();
    }
}
