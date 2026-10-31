// Runs SyncClient in Node against a running sync relay.
// Start the relay first (npm run dev in stremio-sync-relay), then:
//     pnpm run test:sync
// RELAY_URL overrides the default ws://127.0.0.1:8787.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Compile SyncClient.ts the way the build does (ts-loader with tsconfig.json),
// so the checks run against the same JavaScript the browser gets. Running the
// source directly once hid a bug that only the ES5 output had.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = fileURLToPath(new URL('..', import.meta.url));
const { config } = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
const sourcePath = `${root}src/common/Sync/SyncClient.ts`;
const { outputText } = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    fileName: sourcePath,
    // Same output as the build except the module format, so Node can load it.
    compilerOptions: { ...options, module: ts.ModuleKind.CommonJS },
});
const compiled = { exports: {} as { default: any } };
new Function('module', 'exports', 'require', outputText)(compiled, compiled.exports, require);
const SyncClient = compiled.exports.default;
console.log(`Testing SyncClient compiled for ${ts.ScriptTarget[options.target ?? ts.ScriptTarget.ES5]}, as in the build\n`);

const RELAY_URL = process.env.RELAY_URL ?? 'ws://127.0.0.1:8787';
const room = `test-${Math.random().toString(36).slice(2, 10)}`;
let failures = 0;

const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `\n      ${detail}`}`);
    if (!ok) failures += 1;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves once the predicate holds, checking every 20 ms; false on timeout.
const until = async (predicate: () => boolean, timeoutMs = 3000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (predicate()) return true;
        await wait(20);
    }
    return predicate();
};

const pc = new SyncClient({ url: RELAY_URL, room, device: 'Windows app' });
const mac = new SyncClient({ url: RELAY_URL, room, device: 'Mac app' });
const states: string[] = [];
pc.on('status', (status) => states.push(status.state));

pc.start();
check('Connects and reaches "connected"', await until(() => pc.status.state === 'connected'), `ended as ${pc.status.state}`);
check('Went through "connecting" first', states[0] === 'connecting' && states.includes('connected'), states.join(' → '));
check('Knows its own name', pc.self?.name === 'Windows app', JSON.stringify(pc.self));
check('Starts with no other devices', pc.devices.length === 0, JSON.stringify(pc.devices));

mac.start();
await until(() => mac.status.state === 'connected');
check('Second device sees the first', mac.devices.some((device) => device.name === 'Windows app'), JSON.stringify(mac.devices));
check('First device sees the second join', await until(() => pc.devices.some((device) => device.name === 'Mac app')), JSON.stringify(pc.devices));

const received: unknown[] = [];
mac.on('message', (message) => received.push(message));
check('send() reports success when connected', pc.send({ type: 'chat', text: 'hello' }));
const got = await until(() => received.length > 0);
const message = received[0] as { type?: string, text?: string, from?: { name?: string } } | undefined;
check('Message reaches the other device with the sender added',
    got && message?.type === 'chat' && message.text === 'hello' && message.from?.name === 'Windows app', JSON.stringify(message));

mac.stop();
check('Stopping says "stopped"', mac.status.state === 'stopped');
check('Others see a stopped device leave', await until(() => pc.devices.length === 0), JSON.stringify(pc.devices));
check('send() reports failure when stopped', mac.send({ type: 'chat', text: 'nope' }) === false);
pc.stop();

// Keepalive: with fast pings, an answered ping keeps the connection up.
const pinger = new SyncClient({ url: RELAY_URL, room, device: 'Pinger', pingInterval: 100, pongTimeout: 80 });
const pingerStates: string[] = [];
pinger.on('status', (status) => pingerStates.push(status.state));
pinger.start();
await until(() => pinger.status.state === 'connected');
await wait(600);
check('Stays connected across several ping/pong rounds',
    pinger.status.state === 'connected' && !pingerStates.includes('waiting'), pingerStates.join(' → '));
pinger.stop();

// A connection that goes quiet: once connected, this client's pings are
// silently dropped, like a network that died without closing the connection.
const stranded = new SyncClient({ url: RELAY_URL, room, device: 'Stranded', pingInterval: 100, pongTimeout: 100, retryMin: 5000 });
stranded.start();
await until(() => stranded.status.state === 'connected');
const socket = (stranded as unknown as { socket: WebSocket }).socket;
const realSend = socket.send.bind(socket);
socket.send = (data) => {
    if (data !== 'ping') realSend(data);
};
check('Notices unanswered pings and starts reconnecting', await until(() => stranded.status.state === 'waiting', 1500), stranded.status.state);
stranded.stop();

// Reconnecting: nothing listens on port 9, so every attempt fails.
const retrier = new SyncClient({ url: 'ws://127.0.0.1:9', room, device: 'Retrier', retryMin: 100, retryMax: 400 });
const delays: number[] = [];
retrier.on('status', (status) => {
    if (status.state === 'waiting') delays.push(status.retryAt - Date.now());
});
retrier.start();
await until(() => delays.length >= 4, 4000);
retrier.stop();
check('Retries after a failed connection', delays.length >= 4, `${delays.length} retries`);
check('Waits longer after repeated failures (backoff)', delays[3] > delays[0], delays.map((d) => Math.round(d)).join(', ') + ' ms');
check('Never waits longer than the cap', delays.every((delay) => delay <= 400), delays.map((d) => Math.round(d)).join(', ') + ' ms');
check('Stops retrying once stopped', retrier.status.state === 'stopped');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
