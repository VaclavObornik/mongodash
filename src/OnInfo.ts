export type OnInfo = (info: { message: string; code: string } & Record<string, string | number | Date>) => void;

export const defaultOnInfo: OnInfo = (info) => {
    console.log(info.message);
};

export function secureOnInfo(onInfo: OnInfo): OnInfo {
    return (info) => {
        try {
            onInfo(info);
        } catch (onErrorFailure) {
            // intentionally suppress
        }
    };
}
