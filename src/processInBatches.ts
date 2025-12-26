import { Collection, Document, Filter } from 'mongodb';

export interface ProcessInBatchesOptions {
    batchSize?: number;
    shouldStop?: () => boolean;
}

export interface ProcessInBatchesResult {
    processedDocuments: number;
    operationsPerformed: number;
}

export async function processInBatches<TDoc extends Document, TOp>(
    collection: Collection<TDoc>,
    queryOrPipeline: Filter<TDoc> | Document[],
    transform: (doc: TDoc) => TOp | TOp[] | null | undefined | Promise<TOp | TOp[] | null | undefined>,
    executeBatch: (ops: TOp[]) => Promise<void>,
    options: ProcessInBatchesOptions = {},
): Promise<ProcessInBatchesResult> {
    const { batchSize = 1000, shouldStop } = options;

    const cursor = Array.isArray(queryOrPipeline) ? collection.aggregate<TDoc>(queryOrPipeline) : collection.find<TDoc>(queryOrPipeline);

    let batch: TOp[] = [];
    let processedDocuments = 0;
    let operationsPerformed = 0;

    while (await cursor.hasNext()) {
        if (shouldStop && shouldStop()) {
            break;
        }

        const doc = (await cursor.next()) as TDoc;
        if (!doc) continue;

        processedDocuments++;
        const result = await transform(doc);

        if (result !== null && result !== undefined) {
            if (Array.isArray(result)) {
                batch.push(...result);
            } else {
                batch.push(result);
            }
        }

        if (batch.length >= batchSize) {
            await executeBatch(batch);
            operationsPerformed += batch.length;
            batch = [];
        }
    }

    if (batch.length > 0) {
        await executeBatch(batch);
        operationsPerformed += batch.length;
    }

    return { processedDocuments, operationsPerformed };
}
