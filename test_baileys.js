const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function test() {
    try {
        console.log("Starting test session...");
        const { state, saveCreds } = await useMultiFileAuthState('./sessions/test_session');
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'info' })
        });

        sock.ev.on('connection.update', (update) => {
            console.log("Update:", update);
            if (update.qr) {
                console.log("QR received!");
                process.exit(0);
            }
        });
        
        sock.ev.on('creds.update', saveCreds);
    } catch (e) {
        console.error("Crash:", e);
    }
}

test();
