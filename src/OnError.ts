import { createSecureHandler } from './createSecureHandler';

export type OnError = (error: Error) => void;

export const defaultOnError: OnError = (error) => {
    console.error(error);
};

// Global variable to hold the current onError handler
let globalOnError: OnError = defaultOnError;

/**
 * Updates the global onError handler.
 * Automatically wraps the provided handler with secureOnError for safety.
 */
export function setGlobalOnError(onError: OnError): void {
    globalOnError = createSecureHandler(onError);
}

/**
 * Global wrapper that delegates to the currently configured onError handler.
 * Can be imported and used directly by any component.
 */
export const onError: OnError = (error) => {
    globalOnError(error);
};

// secureOnError removed
