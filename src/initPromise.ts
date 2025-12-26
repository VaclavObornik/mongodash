let _resolve: () => void;
export const initPromise = new Promise<void>((resolve) => {
    _resolve = resolve;
});

export const resolveInitPromise = _resolve!;
