export const resolver = {
    resolve: null as unknown as () => void,
};

export const initPromise = new Promise<void>((resolve) => {
    resolver.resolve = resolve;
});
