import { Filter, Document } from 'mongodb';
import { ReactiveTaskRecord as BackendReactiveTaskRecord } from '../reactiveTasks/ReactiveTaskTypes';
import { CronTaskRecord as BackendCronTaskRecord } from '../cronTasks';

// --- Shared Entity Types (Derived for API) ---

export type ReactiveTaskStatus = BackendReactiveTaskRecord['status'];

/**
 * Frontend-optimized ReactiveTaskRecord.
 * - _id is always string.
 * - sourceDocId is generic, typically string for display.
 * - Dates remain Date objects (assuming JSON parser handles them or they are strings on wire).
 *   Note: In standard JSON, Dates are strings. The FE likely constructs Date objects.
 *   But existing types said Date. We'll keep Date for TS compatibility assuming transformation or simple casting for now.
 */
export type ReactiveTaskRecord<T = unknown> = Omit<BackendReactiveTaskRecord<T>, '_id' | 'sourceDocId'> & {
    _id: string; // Enforce string for API usage
    sourceDocId: string | number | unknown; // Allow any for FE flexibility, typically string/ObjectId
};

export type CronTaskStatus = BackendCronTaskRecord['status'];

export type CronTaskRecord = Omit<BackendCronTaskRecord, '_id'> & {
    _id: string;
};

// --- API Request/Response Interfaces ---

// Reactive Tasks
export interface GetReactiveTasksRequest {
    limit?: number;
    skip?: number;
    task?: string;
    collection?: string;
    status?: string;
    errorMessage?: string;
    hasError?: string; // 'true' or 'false' as query string
    sourceDocId?: string;
    sortField?: keyof ReactiveTaskRecord;
    sortDirection?: 1 | -1;
}

export interface FacetStats {
    statuses: { _id: string; count: number }[];
    errorCount: number;
}

export interface GetReactiveTasksResponse {
    items: ReactiveTaskRecord[];
    total: number;
    limit: number;
    offset: number;
    stats: FacetStats;
}

export interface RetryReactiveTasksRequest {
    task?: string;
    status?: string;
    errorMessage?: string;
    _id?: string;
    sourceDocId?: string;
    // We accept a loosely typed filter that can be passed to the backend
    sourceDocFilter?: Filter<Document>;
}

export interface RetryReactiveTasksResponse {
    modifiedCount: number;
}

// Cron Tasks
export interface GetCronTasksRequest {
    limit?: number;
    skip?: number;
    filter?: string;
}

export interface GetCronTasksResponse {
    items: CronTaskRecord[];
    total: number;
    limit: number;
    offset: number;
}

export interface TriggerCronTaskRequest {
    taskId: string;
}

export interface TriggerCronTaskResponse {
    success: boolean;
    message?: string;
}

// System Info
export interface GetInfoResponse {
    databaseName: string;
    reactiveTasks: {
        name: string;
        collection: string;
        stats: {
            success: number;
            failed: number;
            processing: number;
            pending: number;
            error: number;
        };
    }[];
    cronTasks: {
        id: string;
        status: CronTaskStatus;
        lastRunError?: string | null;
        nextRunAt?: Date | string;
    }[];
}
