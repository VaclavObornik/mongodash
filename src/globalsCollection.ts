import { Collection, Document, ObjectId } from 'mongodb';

export type GlobalsCollection = Collection<Document & { _id: ObjectId | string }>;
