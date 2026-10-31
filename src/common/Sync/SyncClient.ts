// Keeps one WebSocket open to the sync relay (github.com/bryanaswez/stremio-sync-relay).
// It reconnects with backoff when the connection drops, pings to notice a dead
// connection, and tracks which other devices are online in the same room.
//
// No imports and only erasable TypeScript, so Node can run it directly in
// tests/syncClient.node.mts.

type SyncDevice = {
    id: string,
    name: string,
};

type SyncStatus =
    | { state: 'connecting' }
    | { state: 'connected' }
    | { state: 'waiting', retryAt: number }
    | { state: 'stopped' };

type SyncMessage = {
    type: string,
    from?: SyncDevice,
    [key: string]: unknown,
};

type OutgoingMessage = {
    type: string,
    [key: string]: unknown,
};

type SyncClientOptions = {
    url: string,
    room: string,
    device: string,
    pingInterval?: number,
    pongTimeout?: number,
    retryMin?: number,
    retryMax?: number,
};

type Events = {
    status: SyncStatus,
    devices: SyncDevice[],
    message: SyncMessage,
};

type Listener<T> = (value: T) => void;

const PING_INTERVAL = 25000;
const PONG_TIMEOUT = 10000;
const RETRY_MIN = 1000;
const RETRY_MAX = 30000;

class SyncClient {
    status: SyncStatus = { state: 'stopped' };
    self: SyncDevice | null = null;
    devices: SyncDevice[] = [];

    private options: Required<SyncClientOptions>;
    private socket: WebSocket | null = null;
    private attempts = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimer: ReturnType<typeof setTimeout> | null = null;
    private listeners: { [E in keyof Events]: Set<Listener<Events[E]>> } = {
        status: new Set(),
        devices: new Set(),
        message: new Set(),
    };

    constructor(options: SyncClientOptions) {
        this.options = {
            pingInterval: PING_INTERVAL,
            pongTimeout: PONG_TIMEOUT,
            retryMin: RETRY_MIN,
            retryMax: RETRY_MAX,
            ...options,
            url: options.url.replace(/\/+$/, ''),
        };
    }

    start() {
        if (this.status.state !== 'stopped') return;
        if (typeof window !== 'undefined') {
            window.addEventListener('online', this.onOnline);
        }
        this.connect();
    }

    stop() {
        if (typeof window !== 'undefined') {
            window.removeEventListener('online', this.onOnline);
        }
        this.clearTimers();
        this.clearRetry();
        const socket = this.socket;
        this.socket = null;
        if (socket !== null) {
            try {
                socket.close(1000, 'Stopped');
            } catch {
                // Already closed.
            }
        }
        this.setDevices(null, []);
        this.setStatus({ state: 'stopped' });
    }

    // Returns false when not connected; the message is dropped, not queued.
    send(message: OutgoingMessage): boolean {
        if (this.status.state !== 'connected' || this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.socket.send(JSON.stringify(message));
        return true;
    }

    on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): () => void {
        this.listeners[event].add(listener);
        return () => {
            this.listeners[event].delete(listener);
        };
    }

    private connect() {
        this.clearRetry();
        const { url, room, device } = this.options;
        const socket = new WebSocket(`${url}/room/${encodeURIComponent(room)}?device=${encodeURIComponent(device)}`);
        this.socket = socket;
        this.setStatus({ state: 'connecting' });

        // Events from a socket we've already given up on are ignored.
        socket.addEventListener('message', (event) => {
            if (this.socket === socket) this.onMessage(event.data);
        });
        // An 'error' event is always followed by 'close', so 'close' covers both.
        socket.addEventListener('close', () => {
            if (this.socket === socket) this.onDrop();
        });
    }

    private onMessage(data: unknown) {
        if (data === 'pong') {
            if (this.pongTimer !== null) {
                clearTimeout(this.pongTimer);
                this.pongTimer = null;
            }
            return;
        }
        if (typeof data !== 'string') return;

        let message: unknown;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }
        if (!isMessage(message)) return;

        switch (message.type) {
            case 'welcome': {
                this.attempts = 0;
                this.setDevices(message.you as SyncDevice, message.devices as SyncDevice[]);
                this.setStatus({ state: 'connected' });
                this.startPinging();
                break;
            }
            case 'device-joined': {
                const joined = message.device as SyncDevice;
                if (!this.devices.some((device) => device.id === joined.id)) {
                    this.setDevices(this.self, [...this.devices, joined]);
                }
                break;
            }
            case 'device-left': {
                const left = message.device as SyncDevice;
                this.setDevices(this.self, this.devices.filter((device) => device.id !== left.id));
                break;
            }
            case 'error': {
                console.warn('Sync relay:', message.message);
                break;
            }
            default: {
                this.emit('message', message);
            }
        }
    }

    private onDrop() {
        this.socket = null;
        this.clearTimers();
        this.setDevices(null, []);

        const { retryMin, retryMax } = this.options;
        // Doubles each attempt, capped, with jitter so devices don't retry in step.
        const delay = Math.min(retryMax, retryMin * 2 ** this.attempts) * (0.5 + Math.random() * 0.5);
        this.attempts += 1;
        this.retryTimer = setTimeout(() => this.connect(), delay);
        this.setStatus({ state: 'waiting', retryAt: Date.now() + delay });
    }

    private startPinging() {
        this.clearTimers();
        const { pingInterval, pongTimeout } = this.options;
        this.pingTimer = setInterval(() => {
            const socket = this.socket;
            if (socket === null || socket.readyState !== WebSocket.OPEN || this.pongTimer !== null) return;
            socket.send('ping');
            this.pongTimer = setTimeout(() => {
                // No reply: treat the connection as dead without waiting for the
                // browser, which can take minutes to notice.
                this.pongTimer = null;
                this.onDrop();
                try {
                    socket.close(4000, 'No reply to ping');
                } catch {
                    // Already closed.
                }
            }, pongTimeout);
        }, pingInterval);
    }

    // Back online: retry now instead of waiting out the backoff.
    private onOnline = () => {
        if (this.status.state === 'waiting') {
            this.connect();
        }
    };

    private clearTimers() {
        if (this.pingTimer !== null) clearInterval(this.pingTimer);
        if (this.pongTimer !== null) clearTimeout(this.pongTimer);
        this.pingTimer = null;
        this.pongTimer = null;
    }

    private clearRetry() {
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private setStatus(status: SyncStatus) {
        this.status = status;
        this.emit('status', status);
    }

    private setDevices(self: SyncDevice | null, devices: SyncDevice[]) {
        const changed = this.devices.length > 0 || devices.length > 0;
        this.self = self;
        this.devices = devices;
        if (changed) this.emit('devices', devices);
    }

    private emit<E extends keyof Events>(event: E, value: Events[E]) {
        // forEach, not for...of: the build compiles TypeScript to ES5, where
        // for...of only walks arrays and silently skips a Set.
        this.listeners[event].forEach((listener) => {
            try {
                listener(value);
            } catch (error) {
                console.error('Sync listener failed:', error);
            }
        });
    }
}

function isMessage(value: unknown): value is SyncMessage {
    return typeof value === 'object' && value !== null && typeof (value as SyncMessage).type === 'string';
}

export default SyncClient;
export type {
    SyncDevice,
    SyncStatus,
    SyncMessage,
    OutgoingMessage,
    SyncClientOptions,
};
