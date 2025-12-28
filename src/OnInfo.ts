import { createSecureHandler } from './createSecureHandler';

export type OnInfo = (info: { message: string; code: string } & Record<string, unknown>) => void;

export const defaultOnInfo: OnInfo = (info) => {
    console.log(info.message);
    if ('error' in info) {
        console.error('ERROR DETAIL:', JSON.stringify(info, null, 2));
    }
};

// Global variable to hold the current onInfo handler
let globalOnInfo: OnInfo = defaultOnInfo;

/**
 * Updates the global onInfo handler.
 * Automatically wraps the provided handler with secureOnInfo for safety.
 */
export function setGlobalOnInfo(onInfo: OnInfo): void {
    globalOnInfo = createSecureHandler(onInfo);
}

/**
 * Global wrapper that delegates to the currently configured onInfo handler.
 * Can be imported and used directly by any component.
 */
export const onInfo: OnInfo = (info) => {
    globalOnInfo(info);
};

// secureOnInfo removed
