import { Document, FindOneAndUpdateOptions, BulkWriteOptions } from 'mongodb';

/**
 * Compatible options for findOneAndUpdate across MongoDB drivers v4, v5, v6, v7.
 * v5+ requires 'includeResultMetadata' to return the full result object.
 * v4 ignores this property.
 * Using Omit ensures we don't conflict with existing definition if it exists,
 * and explicitly adding it ensures it's allowed even if the base type lacks it.
 */
export interface CompatibleFindOneAndUpdateOptions extends Omit<FindOneAndUpdateOptions, 'includeResultMetadata'> {
    includeResultMetadata?: boolean;
}

/**
 * Compatible result for findOneAndUpdate.
 * Wraps the potential return shapes.
 * v4: { value: T, ok: 1, ... }
 * v7 (with includeResultMetadata): { value: T, ok: 1, ... }
 *
 * Accessing .value on this interface is safe.
 */
export interface CompatibleModifyResult<T extends Document = Document> {
    value?: T | null;
    ok?: number;
    lastErrorObject?: Document;
}

/**
 * Compatible options for bulkWrite.
 * Ensures strict typing.
 */
export type CompatibleBulkWriteOptions = BulkWriteOptions;
