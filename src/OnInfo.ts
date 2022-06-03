export interface Info extends Record<string, string | number | Date> {
    message: string;
    code: string;
}

export interface OnInfo {
    (info: Info): void;
}

const listeners: Array<OnInfo> = [];

export function addOnInfoListener(listener: OnInfo) {
    listeners.push(listener);
}

export function onInfo(info: Info): void {
    for (const listener of listeners) {
        try {
            listener(info);
        } catch (onErrorFailure) {
            // intentionally suppress
        }
    }
}

export function defaultOnInfoListener(info: Info) {
    console.log(info.message);
}
