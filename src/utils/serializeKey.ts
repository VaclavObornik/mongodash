import stringify = require('fast-json-stable-stringify');
import * as mongodb from 'mongodb';

// Attempt to get EJSON from mongodb if available (Driver 4+)
// logic: verify if EJSON exists on the imported object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DriverEJSON = (mongodb as any).EJSON;

/**
 * Serializes a MongoDB document/ID into a stable, canonical string key.
 *
 * Strategy:
 * 1. Try to use the native Driver's EJSON.stringify (Driver 4+).
 * 2. If unavailable (Driver 3), manually transform legacy BSON types (ObjectId)
 *    into a canonical format (e.g. { $oid: ... }) and then use stable JSON stringify.
 *
 * This avoids collisions between ObjectId("abc") and string "abc".
 */
export function serializeKey(doc: unknown): string {
    if (DriverEJSON && typeof DriverEJSON.stringify === 'function') {
        try {
            return DriverEJSON.stringify(doc, { relaxed: false });
        } catch {
            // If native EJSON fails (e.g. due to mixed versions), fall through
        }
    }

    // Fallback for Driver 3 or incompatible types
    const transformed = transformLegacyTypes(doc);
    return stringify(transformed);
}

function transformLegacyTypes(doc: unknown): unknown {
    if (doc === null || typeof doc !== 'object') {
        return doc;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docObj = doc as any;

    // Handle Driver 3 ObjectId
    // Check for _bsontype: 'ObjectID' (legacy) or 'ObjectId' (modern)
    if (docObj._bsontype === 'ObjectID' || docObj._bsontype === 'ObjectId') {
        if (typeof docObj.toHexString === 'function') {
            return { $oid: docObj.toHexString() };
        }
    }

    // Handle Arrays
    if (Array.isArray(doc)) {
        return doc.map(transformLegacyTypes);
    }

    // Handle Plain Objects
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newObj: any = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const key of Object.keys(doc as any)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        newObj[key] = transformLegacyTypes((doc as any)[key]);
    }
    return newObj;
}
