import { MongoClient } from 'mongodb';
import { getConnectionString } from './testingDatabase';

export default async () => {
    const uri = getConnectionString();
    console.log(`Checking database connection at: ${uri}`);
    try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 }); // Fast fail
        await client.connect();
        await client.db('admin').command({ ping: 1 });
        await client.close();
        console.log('Database connection successful.');
    } catch (err) {
        console.error('Database connection failed! Ensure MongoDB is running.');
        console.error('Error:', (err as Error).message);
        throw err; // Throwing error will cause Jest to fail fast
    }
};
