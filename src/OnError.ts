export type OnError = (error: Error) => void;

export const defaultOnError: OnError = (error) => {
    console.error(error);
};

export function secureOnError(onError: OnError): OnError {
    return (error) => {
        try {
            onError(error);
        } catch (onErrorFailure) {
            // intentionally suppress
        }
    };
}
