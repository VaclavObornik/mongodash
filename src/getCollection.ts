'use strict';

import { Collection, DbCollectionOptions } from 'mongodb';
import { getMongoClient } from './getMongoClient';

export type CollectionFactory = <T>(name: string, options?: DbCollectionOptions) => Collection<T> | null;

let collectionFactory: CollectionFactory | null;

export type InitOptions = {
    /**
     * @deprecated
     * @experimental
     * @description Only for testing purposes, this method can be removed in a future version of mongodash
     * The method allows to configure the getCollection method to provide singletons, which can be used
     * in automated test to control database query results and simulate exceptions
     */
    collectionFactory: CollectionFactory | null;
};

export function init(options: InitOptions): void {
    collectionFactory = options.collectionFactory;
}

let depthCallCounter = 0;

export function getCollection<T>(name: string, options: DbCollectionOptions = {}): Collection<T> {
    try {
        depthCallCounter++;
        if (collectionFactory && depthCallCounter === 1) {
            const collection: Collection | null = collectionFactory(name, options);
            if (collection) {
                return collection;
            }
        }
        return getMongoClient().db().collection(name, options);
    } finally {
        depthCallCounter--;
    }
}
