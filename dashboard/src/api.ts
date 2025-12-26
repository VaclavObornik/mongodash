import type {
    GetReactiveTasksResponse,
    GetReactiveTasksRequest,
    RetryReactiveTasksRequest,
    RetryReactiveTasksResponse,
    GetCronTasksRequest,
    GetCronTasksResponse,
    TriggerCronTaskRequest,
    TriggerCronTaskResponse,
    GetInfoResponse
} from '@shared/types';

const API_BASE = './api';

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(API_BASE + url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API Error ${res.status}: ${text}`);
    }

    return res.json();
}

export const api = {
    reactive: {
        list: (params: GetReactiveTasksRequest) => {
            const query = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== '') {
                    query.append(key, String(value));
                }
            });
            return fetchJson<GetReactiveTasksResponse>(`/reactive/list?${query.toString()}`);
        },
        retry: (data: RetryReactiveTasksRequest) => {
            return fetchJson<RetryReactiveTasksResponse>('/reactive/retry', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        }
    },
    cron: {
        list: (params: GetCronTasksRequest) => {
            const query = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== '') {
                    query.append(key, String(value));
                }
            });
            return fetchJson<GetCronTasksResponse>(`/cron/list?${query.toString()}`);
        },
        trigger: (data: TriggerCronTaskRequest) => {
            return fetchJson<TriggerCronTaskResponse>('/cron/trigger', {
                method: 'POST',
                body: JSON.stringify(data)
            });
        }
    },
    info: () => {
        return fetchJson<GetInfoResponse>('/info');
    }
};
