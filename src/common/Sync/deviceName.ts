// The name other devices see, like "Windows app" or "Mac browser".
// Stored per browser, so the desktop app and each browser keep their own.

const STORAGE_KEY = 'syncDeviceName';
const MAX_LENGTH = 40;

const OS_LABELS: Record<string, string> = {
    windows: 'Windows',
    macos: 'Mac',
    linux: 'Linux',
    'chrome os': 'Chromebook',
    android: 'Android',
    ios: 'iPhone or iPad',
};

const defaultDeviceName = (platformName: string, isShell: boolean) => {
    const os = OS_LABELS[platformName] ?? 'Unknown';
    return isShell ? `${os} app` : `${os} browser`;
};

const getDeviceName = (platformName: string, isShell: boolean) => {
    let stored: string | null = null;
    try {
        stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
        // Storage blocked; use the default.
    }
    const name = stored?.trim().slice(0, MAX_LENGTH);
    return name || defaultDeviceName(platformName, isShell);
};

export {
    getDeviceName,
};
