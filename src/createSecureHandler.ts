/**
 * Creates a secure wrapper for a handler function.
 * The wrapped function will catch and suppress any errors thrown by the handler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSecureHandler<T extends (...args: any[]) => any>(handler: T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((...args: any[]) => {
        try {
            const result = handler(...args);
            // An async handler (e.g. `onError: async e => await alerting.post(e)`)
            // returns a promise; a rejection here would become an unhandled
            // rejection and, on Node >=15, terminate the process. Swallow it too.
            if (result && typeof (result as { then?: unknown }).then === 'function') {
                return (result as Promise<unknown>).catch(() => undefined);
            }
            return result;
        } catch {
            // intentionally suppress
        }
    }) as T;
}
