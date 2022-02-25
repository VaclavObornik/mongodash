import { getCollection } from './getCollection';
import { Collection, Filter } from 'mongodb';
import { OnError } from './OnError';
import d from 'deep';
import { cloneDeep } from 'lodash';

const noChange = Symbol('noChange');

type AllowedVersionType = string | number;
type AllowedValueType = Record<any, unknown>;
export type Key = string;

/**
 * To consider:
 * - add "type" property which can be fixed -> this would allow to have multiple types of documents in one collection
 * - OR make the document to have the fields on top level
 */

type Document<ValueType extends AllowedValueType, VersionType extends AllowedVersionType> = {
    _id: Key;
    version: VersionType;
    value: ValueType;
    refreshedAt: Date;
};

export type ValueProvider<ValueType, VersionType> = (key: Key, cachedVersion: VersionType | null, noChange: symbol) => ValueType | typeof noChange | Promise<ValueType | typeof noChange>;

export type ValueProtection = 'freeze' | 'clone';

export type CacheOptions<ValueType, VersionType> = {
    collectionName?: string;
    keepInMemory?: boolean; // todo use a library for in memory cache?
    lifeTime: number;
    keepExpired?: boolean;
    valueProtection?: ValueProtection;
    valueProvider: ValueProvider<ValueType, VersionType>;
    onError: OnError;
};

type CachedValue<ValueType, VersionType> = {
    value: ValueType | null;
    version: VersionType;
};

export type GetResult<Value extends AllowedValueType, Version extends AllowedVersionType> = Promise<{ value?: Value; version: Version; versionMatch: boolean }>;

type ValueResult<Value extends AllowedValueType, Version extends AllowedVersionType> = {
    currentVersion: Version;
    getValue: () => Promise<CachedValue<Value, Version>>;
};

/**
 * TODO
 * 1. return freezed by default OR deepClone
 *
 */

class Cache<Value extends AllowedValueType, Version extends AllowedVersionType> {
    private _memoryCache = new Map<Key, Document<Value, Version>>(); // TODO

    private _gettingPromises = new Map<string, Promise<ValueResult<Value, Version>>>();

    private _fetchingPromises = new Map();

    private readonly _collection: Collection<Document<Value, Version>>;

    private readonly _options: CacheOptions<Value, Version>;

    constructor({
        collectionName = 'cache',
        // add a "type" property which will be in every document, so documents can be recognizes from each other, also indexes can be
        // built on it and
        keepInMemory = false,
        valueProvider,
        lifeTime = 0,
        valueProtection,
        keepExpired = true,
        onError,
    }: CacheOptions<Value, Version>) {
        this._collection = getCollection<Document<Value, Version>>(collectionName);
        this._options = {
            keepInMemory,
            valueProvider,
            lifeTime,
            valueProtection,
            keepExpired,
            onError,
        };
    }

    get(
        key: Key,
        {
            ifVersionNotMatch = null,
            timeout = Number.MAX_SAFE_INTEGER,
            timeoutIfEmpty = false,
        }: {
            ifVersionNotMatch?: Version | null;
            timeout?: number;
            timeoutIfEmpty?: boolean;
        } = {},
    ): GetResult<Value, Version> {
        if (!this._gettingPromises.has(key)) {
            const promise = this._getValueMeta(key);
            this._gettingPromises.set(key, promise);
        }

        return this._gettingPromises.get(key)!.then(async ({ currentVersion, getValue }) => {
            if (ifVersionNotMatch && currentVersion === ifVersionNotMatch) {
                return { version: currentVersion, versionMatch: true };
            }

            const { version, value } = await getValue();

            if (ifVersionNotMatch && version === ifVersionNotMatch) {
                return { version, versionMatch: true };
            }

            return {
                version,
                versionMatch: false,
                value: this._options.valueProtection === 'clone' ? cloneDeep<Value>(value!) : value!,
            };
        });
    }

    private async _getValueMeta(key: Key): Promise<ValueResult<Value, Version>> {
        const thresholdDate = new Date(Date.now() - this._options.lifeTime);
        let result: ValueResult<Value, Version> | null;
        result = await this.getResultFromMemory(key, thresholdDate);
        if (result) {
            return result;
        }

        result = await this.getResultFromDatabase(key, thresholdDate);
        if (result) {
            return result;
        }

        // v paměti ani v databazi jsme nenasli dostatecne cerstvy dokument, zkusime providera
        try {
            const currentVersion = await this.getFromDatabase(key, true, null);
            // todo lock the provider usage
            const resultValue: Value | typeof noChange = await this._options.valueProvider(key, currentVersion?.version || null, noChange);
            if (resultValue === noChange) {
                // prolong the document version
                if (this._options.lifeTime > 0) {
                    // optimization - if the lifetime is 0, we call provider everytime
                    // so we don't need to set new refreshedAt value, which cause all document need to be replicated (document can be large
                    // and in such case with combination of frequent cache function call it can lower the oplog window dramatically)
                    await this.setDatabaseRefreshed(key);
                }
            } else {
                return this.saveFreshValue(key, Value, );
            }
            return this.getResultFromDatabase(key, null);
        } catch (err) {
            // todo
        }
    }

    private getResultFromMemory(key: string, thresholdDate: Date): ValueResult<Value, Version> | null {
        const memoryValue = this.getFromMemory(key, thresholdDate);
        if (memoryValue) {
            return {
                currentVersion: memoryValue.version,
                getValue: async () => memoryValue,
            };
        }
        return null;
    }

    private async getResultFromDatabase(key: string, thresholdDate: Date | null) {
        try {
            const databaseRecord = await this.getFromDatabase(key, true, thresholdDate);
            if (databaseRecord) {
                return {
                    currentVersion: databaseRecord.version,
                    getValue: async (): Promise<CachedValue<Value, Version>> => {
                        const fullDatabaseRecord = await this.getFromDatabase(key, false, null);

                        if (fullDatabaseRecord) {
                            if (this._options.keepInMemory) {
                                this.saveToMemory(key, fullDatabaseRecord);
                            }
                            return fullDatabaseRecord;
                        }

                        // TODO something went wrong... maybe only throw exception?
                        // maybe we can log an error and provide value from memory if there is any
                        throw Error('error!!!'); // TODO
                    },
                };
            }
        } catch (err) {
            this._options.onError(err as Error);
            // todo tady pravdepodobne vyhodit? musime si vybrat - budto vyhodime vyjimkum, nebo pustime dal ale riskujeme zahlceni providera
            // i kdyz by to volani nemelo byt paralelni...
        }
        return null;
    }

    private async getFromDatabase(key: Key, onlyVersion: boolean, onlyIfNewerThan: Date | null): Promise<Document<Value, Version> | null> {
        let projection;
        if (onlyVersion) {
            projection = { version: true };
        }

        const filter: Filter<Document<Value, Version>> = { _id: key };
        if (onlyIfNewerThan) {
            filter.refreshedAt = { $gte: onlyIfNewerThan };
        }

        try {
            return await this._collection.findOne(filter, { projection });
        } catch (err) {
            this._options.onError(err as Error);
            return null;
        }
    }

    private async setDatabaseRefreshed(key: Key) {
        await this._collection.updateOne({ _id: key }, { $set: { refreshedAt: new Date() } });
    }

    private async saveFreshValue(key: Key, value: Value, version: Version): Promise<ValueResult<Value, Version>> {
        const document: Document<Value, Version> = {
            _id: key,
            value,
            version,
            refreshedAt: new Date(),
        };

        this.saveToMemory(key, document);

        await this._collection.replaceOne({ _id: key }, document, { upsert: true });
        return {
            currentVersion: version,
            getValue: () => Promise.resolve({ value, version }),
        };
    }

    _getHappyFlow() {
        /**
         * if the lifeTime is greater than 0
         *      -> check the inmemory
         *      -> if key is not there OR is expired and lifeTime is greater than 0
         *      - check the database
         * když je lifetime 0, muzeme rovnou stahovat z URL...
         *
         * meta kolekce
         *  - cista data NE -> musime zaroven uchovavat verzi
         *  + kdyz budeme casto menit cas updatu, bude se nam zabirat oplog
         *
         *  zamykat fetchovani resource?
         */
    }

    _getFailureFlow() {
        // tady bychom se meli rozhodovat podle toho, kde nastala chyba... jestli na databazi,
        // nema smysl z ni zkouset cist znova... (?)
    }

    delete() {}

    deleteAll() {}

    private saveToMemory(key: Key, record: Document<Value, Version>) {
        if (this._options.keepInMemory) {
            if (this._options.valueProtection === 'freeze') {
                // todo
            }
            this._memoryCache.set(key, record);
        }
    }

    private getFromMemory(key: Key, onlyIfNewerThan: Date | null): Document<Value, Version> | null {
        const record = this._memoryCache.get(key) ?? null;
        if (record && onlyIfNewerThan && record.refreshedAt >= onlyIfNewerThan) {
            return null;
        }
        return record;
    }
}

export function cacheFactory({ collectionName = 'cache', keepInMemory: boolean = false } = {}) {
    const collection = getCollection(collectionName);
}
