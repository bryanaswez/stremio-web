import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePlatform } from '../Platform';
import useProfile from '../useProfile';
import SyncClient from './SyncClient';
import type { OutgoingMessage, SyncDevice, SyncMessage, SyncStatus } from './SyncClient';
import { getDeviceName } from './deviceName';

// Set at build time; null turns sync off. webpack.http.config.js points dev
// builds at the local relay (ws://127.0.0.1:8787).
const RELAY_URL = typeof process.env.SYNC_RELAY_URL === 'string' && process.env.SYNC_RELAY_URL.length > 0 ?
    process.env.SYNC_RELAY_URL
    :
    null;

// Must match the relay's /room/<name> pattern.
const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

type SyncContextValue = {
    // A relay address was set at build time.
    available: boolean,
    signedIn: boolean,
    status: SyncStatus,
    deviceName: string,
    // The other devices online in your room, not including this one.
    devices: SyncDevice[],
    send: (message: OutgoingMessage) => boolean,
    subscribe: (listener: (message: SyncMessage) => void) => () => void,
};

const SyncContext = createContext<SyncContextValue | null>(null);

type Props = {
    children: React.ReactNode,
};

const SyncProvider = ({ children }: Props) => {
    const { shell, name: platformName } = usePlatform();
    const profile = useProfile();
    const userId = profile.auth?.user?._id ?? null;
    // One room per Stremio account. Phase 6 moves this to the relay, which will
    // work it out from a verified login instead of trusting the client.
    const room = userId !== null && ROOM_NAME.test(`user-${userId}`) ? `user-${userId}` : null;
    const deviceName = useMemo(() => getDeviceName(platformName, shell.active === true), [platformName, shell.active]);

    const [status, setStatus] = useState<SyncStatus>({ state: 'stopped' });
    const [devices, setDevices] = useState<SyncDevice[]>([]);
    const client = useRef<SyncClient | null>(null);
    // Kept here, not on the client, so subscriptions survive a reconnect to a new room.
    const messageListeners = useRef(new Set<(message: SyncMessage) => void>());

    useEffect(() => {
        if (RELAY_URL === null || room === null) return;

        const next = new SyncClient({ url: RELAY_URL, room, device: deviceName });
        const unsubscribe = [
            next.on('status', setStatus),
            next.on('devices', setDevices),
            next.on('message', (message) => {
                // forEach, not for...of: see SyncClient.emit.
                messageListeners.current.forEach((listener) => listener(message));
            }),
        ];
        client.current = next;
        next.start();

        return () => {
            unsubscribe.forEach((off) => off());
            next.stop();
            client.current = null;
            setStatus({ state: 'stopped' });
            setDevices([]);
        };
    }, [room, deviceName]);

    const send = useCallback((message: OutgoingMessage) => {
        return client.current !== null && client.current.send(message);
    }, []);

    const subscribe = useCallback((listener: (message: SyncMessage) => void) => {
        messageListeners.current.add(listener);
        return () => {
            messageListeners.current.delete(listener);
        };
    }, []);

    const value = useMemo(() => ({
        available: RELAY_URL !== null,
        signedIn: room !== null,
        status,
        deviceName,
        devices,
        send,
        subscribe,
    }), [room, status, deviceName, devices, send, subscribe]);

    return (
        <SyncContext.Provider value={value}>
            {children}
        </SyncContext.Provider>
    );
};

const useSync = () => {
    const value = useContext(SyncContext);
    if (value === null) {
        throw new Error('useSync must be used inside SyncProvider');
    }
    return value;
};

export {
    SyncProvider,
    useSync,
};
