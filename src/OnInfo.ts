export type OnInfo = (info: { message: string; code: string } & Record<string, unknown>) => void;

export const defaultOnInfo: OnInfo = (info) => {
    console.log(info.message);
    if ('error' in info) {
        console.error('ERROR DETAIL:', JSON.stringify(info, null, 2));
    }
};

export function secureOnInfo(onInfo: OnInfo): OnInfo {
    return (info) => {
        try {
            onInfo(info);
        } catch {
            // intentionally suppress
        }
    };
}
