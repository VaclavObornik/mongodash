let _resolve: () => void;
let _reject: (err: Error) => void;
export const initPromise = new Promise<void>((resolve, reject) => {
    _resolve = resolve;
    _reject = reject;
});

// A rejected initPromise with no registration awaiting it yet must not
// crash the process as an unhandled rejection.
initPromise.catch(() => undefined);

export const resolveInitPromise = _resolve!;
export const rejectInitPromise = _reject!;
