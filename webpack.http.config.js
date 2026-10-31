// Development config for loading the web UI in the Stremio desktop app.
// Wraps webpack.config.js and serves the dev server over plain HTTP, since the
// desktop shell (WebView2) won't load the default self-signed HTTPS certificate.

const baseConfig = require('./webpack.config.js');

// Point the sync feature at the local relay (npm run dev in stremio-sync-relay)
// unless SYNC_RELAY_URL is already set.
process.env.SYNC_RELAY_URL = process.env.SYNC_RELAY_URL || 'ws://127.0.0.1:8787';

module.exports = (env, argv) => {
    const config = baseConfig(env, argv);
    return {
        ...config,
        devServer: {
            ...config.devServer,
            server: 'http',
            // Fail if 8080 is taken instead of silently moving to another port.
            port: 8080,
            client: {
                overlay: {
                    // The desktop shell's injected script references an undefined
                    // `initShellComm` on load; ignore it, show every other error.
                    runtimeErrors: (error) => !/initShellComm/.test(error?.message ?? ''),
                },
            },
        },
    };
};
