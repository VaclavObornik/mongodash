let _resolve: () => void;
export const initPromise = new Promise<void>((resolve) => {
    _resolve = resolve;
});

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const resolveInitPromise = _resolve!;
