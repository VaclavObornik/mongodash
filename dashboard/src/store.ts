import { ref, computed } from 'vue';
import { api } from './api';

// Version for local storage schema - increment when storage format changes
const STORAGE_VERSION = '2';
const STORAGE_KEY = 'mongodash_prefs';

type TimezonePreference = 'local' | 'utc';

interface StoredPrefs {
    version: string;
    autoRefreshSeconds: number; // 0 = off, >0 = on with interval
    timezone: TimezonePreference;
    locale: string; // 'auto' or specific locale like 'en-US', 'cs-CZ'
}


function loadPrefs(): StoredPrefs | null {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return null;
        const prefs = JSON.parse(stored) as StoredPrefs;
        if (prefs.version !== STORAGE_VERSION) {
            // Version mismatch - clear and return null
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return prefs;
    } catch {
        return null;
    }
}

function savePrefs() {
    const prefs: StoredPrefs = {
        version: STORAGE_VERSION,
        autoRefreshSeconds: refreshState.autoRefresh.value ? refreshState.intervalSeconds.value : 0,
        timezone: refreshState.timezone.value,
        locale: refreshState.locale.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// Initialize from stored preferences
const storedPrefs = loadPrefs();
const initialAutoRefresh = storedPrefs?.autoRefreshSeconds ?? 0;
const initialTimezone = storedPrefs?.timezone ?? 'local';
const initialLocale = storedPrefs?.locale ?? 'auto';

const timezone = ref<TimezonePreference>(initialTimezone);
const locale = ref<string>(initialLocale);
const timezoneSuffix = computed(() => timezone.value === 'utc' ? 'UTC' : 'LT');

export const refreshState = {
    trigger: ref(0),
    autoRefresh: ref(initialAutoRefresh > 0),
    intervalSeconds: ref(initialAutoRefresh > 0 ? initialAutoRefresh : 10),
    lastRefresh: ref(new Date()),
    databaseName: ref(''),
    reactiveTasks: ref<
        {
            name: string;
            collection: string;
            stats: { success: number; failed: number; processing: number; pending: number; error: number };
        }[]
    >([]),
    cronTasks: ref<{ id: string; status: string; lastRunError?: string | null; nextRunAt?: string | Date }[]>([]),
    timezone,
    locale,
    timezoneSuffix,
};

export async function fetchInfo() {
    try {
        const info = await api.info();
        refreshState.databaseName.value = info.databaseName;
        refreshState.reactiveTasks.value = info.reactiveTasks || [];
        refreshState.cronTasks.value = info.cronTasks || [];
    } catch (e) {
        console.error('Failed to fetch info', e);
    }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function setAutoRefresh(seconds: number) {
    if (seconds === 0) {
        refreshState.autoRefresh.value = false;
        stopTimer();
    } else {
        refreshState.autoRefresh.value = true;
        refreshState.intervalSeconds.value = seconds;
        refreshState.lastRefresh.value = new Date();
        startTimer();
    }
    savePrefs();
}

export function setTimezone(tz: TimezonePreference) {
    refreshState.timezone.value = tz;
    savePrefs();
}

export function setLocale(l: string) {
    refreshState.locale.value = l;
    savePrefs();
}

// Keep for backward compatibility
export function toggleAutoRefresh() {
    setAutoRefresh(refreshState.autoRefresh.value ? 0 : refreshState.intervalSeconds.value);
}

export function setRefreshInterval(seconds: number) {
    setAutoRefresh(seconds);
}

/**
 * Format a date/time using browser locale settings and respecting timezone preference.
 */
export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: refreshState.timezone.value === 'utc' ? 'UTC' : undefined
    };
    const localeToUse = refreshState.locale.value === 'auto' ? undefined : refreshState.locale.value;
    let result = d.toLocaleString(localeToUse, options);

    // Fix for Czech formatting: remove spaces after dots (21. 12. -> 21.12.)
    if (refreshState.locale.value === 'cs-CZ') {
        result = result.replace(/\. /g, '.');
    }

    return result;
}

function startTimer() {
    stopTimer();
    intervalId = setInterval(async () => {
        await fetchInfo();
        refreshState.trigger.value++;
        refreshState.lastRefresh.value = new Date();
    }, refreshState.intervalSeconds.value * 1000);
}

function stopTimer() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

// Start the timer if auto-refresh was enabled from stored prefs
if (initialAutoRefresh > 0) {
    startTimer();
}
