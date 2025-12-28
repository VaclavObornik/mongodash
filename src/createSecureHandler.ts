/**
 * Creates a secure wrapper for a handler function.
 * The wrapped function will catch and suppress any errors thrown by the handler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSecureHandler<T extends (...args: any[]) => any>(handler: T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((...args: any[]) => {
        try {
            return handler(...args);
        } catch {
            // intentionally suppress
        }
    }) as T;
}
