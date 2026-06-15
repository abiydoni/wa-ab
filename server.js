const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Catch all errors for Passenger debugging
process.on('uncaughtException', (err) => {
    fs.appendFileSync(path.join(__dirname, 'passenger-error.log'), new Date().toISOString() + ' uncaughtException: ' + err.stack + '\n');
});
process.on('unhandledRejection', (reason, promise) => {
    fs.appendFileSync(path.join(__dirname, 'passenger-error.log'), new Date().toISOString() + ' unhandledRejection: ' + reason + '\n');
});

// Set timezone to Asia/Jakarta (WIB)
process.env.TZ = 'Asia/Jakarta';

const session = require('express-session');
const axios = require('axios');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express Session for Admin Login
app.use(session({
    secret: 'wa-gateway-super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set true if HTTPS
}));

const PORT = process.env.PORT || 3456;
const sessionsDir = path.join(__dirname, 'sessions');

// Store active socket connections and QR codes
const activeSessions = new Map();
const authStates = new Map();
const qrCodes = new Map();
const reconnectingSessions = new Set();
const stoppedSessions = new Set();

const sessionContacts = new Map();


// Ensure sessions directory exists
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir);
}

// ==========================================
// DATABASE CONFIGURATION
// ==========================================
let db;
async function initDatabase() {
    try {
        db = await mysql.createPool({
            host: 'localhost', // Usually localhost on cPanel
            user: 'appsbeem_admin',
            password: 'A7by777__',
            database: 'appsbeem_wa_ab',
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            timezone: '+07:00' // Ensure DB queries use WIB timezone
        });

        console.log("✅ Connected to MySQL Database");

        // 1. Drop unused Prisma tables safely by getting a single connection
        const conn = await db.getConnection();
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        const oldTables = [
            'User', 'Session', 'Contact', 'Message', 'Group', 'AutoReply', 
            'Story', 'ScheduledMessage', 'AuthState', 'Webhook', 'BotConfig', 
            'SystemConfig', 'Label', 'ChatLabel', 'Notification', 'SessionAccess', '_prisma_migrations'
        ];
        for (const table of oldTables) {
            await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        conn.release();

        // 2. Create new tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'user'
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS gateway_devices (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100),
                api_key VARCHAR(100) NOT NULL,
                webhook_url VARCHAR(255),
                user_id INT,
                msg_sent INT DEFAULT 0,
                msg_received INT DEFAULT 0
            )
        `);

        // Safely add columns if they don't exist (for existing tables)
        try {
            await db.query('ALTER TABLE admin_users ADD COLUMN role VARCHAR(20) DEFAULT "user"');
        } catch(e) { /* Ignore if columns already exist */ }
        try {
            await db.query('ALTER TABLE gateway_devices ADD COLUMN user_id INT');
            await db.query('ALTER TABLE gateway_devices ADD COLUMN msg_sent INT DEFAULT 0');
            await db.query('ALTER TABLE gateway_devices ADD COLUMN msg_received INT DEFAULT 0');
        } catch(e) { /* Ignore if columns already exist */ }

        // 3. Insert default admin if not exists
        const [admins] = await db.query('SELECT * FROM admin_users');
        if (admins.length === 0) {
            const defaultHash = await bcrypt.hash('admin123', 10);
            await db.query('INSERT INTO admin_users (username, password, role) VALUES (?, ?, "admin")', ['admin', defaultHash]);
            console.log("✅ Default Admin Created (admin / admin123)");
        } else {
            // Ensure the main 'admin' user always has the admin role
            await db.query('UPDATE admin_users SET role = "admin" WHERE username = "admin"');
        }

    } catch (error) {
        console.error("❌ Database Connection Error:", error.message);
        // Fallback or retry logic can be added here
    }
}


// ==========================================
// WHATSAPP ENGINE
// ==========================================
// Utility function to format phone number
const formatPhone = (phone) => {
    if (!phone) return phone;
    phone = phone.trim();
    if (phone.includes('@')) return phone;
    
    // If it looks like a group ID without @g.us (e.g. contains hyphen)
    if (phone.includes('-')) return phone + '@g.us';

    let formatted = phone.replace(/\D/g, '');
    
    // Modern WhatsApp group IDs start with 120 and are 18 digits long
    if (formatted.startsWith('120') && formatted.length >= 18) {
        return formatted + '@g.us';
    }

    if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);
    return formatted + '@s.whatsapp.net';
};

async function startSession(sessionId) {
    const sessionPath = path.join(sessionsDir, sessionId);
    
    let authState = authStates.get(sessionId);
    if (!authState) {
        authState = await useMultiFileAuthState(sessionPath);
        authStates.set(sessionId, authState);
    }
    
    const { state, saveCreds } = authState;
    const { version, isLatest } = await fetchLatestBaileysVersion();

    if (!sessionContacts.has(sessionId)) {
        let savedContacts = new Map();
        try {
            const contactsFile = path.join(sessionPath, 'contacts.json');
            if (fs.existsSync(contactsFile)) {
                const data = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
                savedContacts = new Map(data);
            }
        } catch (e) {}
        sessionContacts.set(sessionId, savedContacts);
    }

    // Function to save contacts to file
    const saveContacts = () => {
        try {
            const contactsFile = path.join(sessionPath, 'contacts.json');
            const map = sessionContacts.get(sessionId);
            if (map) {
                fs.writeFileSync(contactsFile, JSON.stringify(Array.from(map.entries())));
            }
        } catch (e) {}
    };

    console.log(`Starting session: ${sessionId}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'error' }),
        markOnlineOnConnect: true,
        syncFullHistory: true,
        getMessage: async (key) => {
            return undefined;
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr);
                qrCodes.set(sessionId, qrImage);
            } catch (err) { }
        }

        if (connection === 'close') {
            const isStoppedByUser = stoppedSessions.has(sessionId);
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut && !isStoppedByUser;
            activeSessions.delete(sessionId);
            qrCodes.delete(sessionId);

            if (shouldReconnect) {
                if (!reconnectingSessions.has(sessionId)) {
                    reconnectingSessions.add(sessionId);
                    console.log(`[${sessionId}] Connection closed due to: ${lastDisconnect.error?.message}. Reconnecting in 5s...`);
                    setTimeout(() => {
                        reconnectingSessions.delete(sessionId);
                        startSession(sessionId);
                    }, 5000);
                }
            } else if (!isStoppedByUser) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                sessionContacts.delete(sessionId);
                authStates.delete(sessionId);
            }
        } else if (connection === 'open') {
            sock.connectedAt = Date.now();
            console.log(`✅ Session ${sessionId} connected!`);
            qrCodes.delete(sessionId);
            activeSessions.set(sessionId, sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Track contacts manually
    sock.ev.on('contacts.upsert', (contacts) => {
        const map = sessionContacts.get(sessionId);
        for (const contact of contacts) {
            if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
                map.set(contact.id, contact.name || contact.notify || contact.verifiedName || contact.id.split('@')[0]);
            }
        }
        saveContacts();
    });

    sock.ev.on('contacts.update', (updates) => {
        const map = sessionContacts.get(sessionId);
        for (const update of updates) {
            if (update.id && update.id.endsWith('@s.whatsapp.net') && (update.name || update.notify || update.verifiedName)) {
                map.set(update.id, update.name || update.notify || update.verifiedName || update.id.split('@')[0]);
            }
        }
        saveContacts();
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
        const map = sessionContacts.get(sessionId);
        if (contacts) {
            for (const contact of contacts) {
                if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
                    map.set(contact.id, contact.name || contact.notify || contact.verifiedName || contact.id.split('@')[0]);
                }
            }
        }
        if (chats) {
            for (const chat of chats) {
                if (chat.id && chat.id.endsWith('@s.whatsapp.net')) {
                    if (!map.has(chat.id)) {
                        map.set(chat.id, chat.name || chat.id.split('@')[0]);
                    }
                }
            }
        }
        saveContacts();
    });

    // WEBHOOK LOGIC: Send incoming messages to client apps
    sock.ev.on('messages.upsert', async m => {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if(textMessage && db) {
            // Increment Received Counter
            await db.query('UPDATE gateway_devices SET msg_received = msg_received + 1 WHERE id = ?', [sessionId]);

            // Find webhook url for this session
            const [rows] = await db.query('SELECT webhook_url FROM gateway_devices WHERE id = ?', [sessionId]);
            if (rows.length > 0 && rows[0].webhook_url) {
                const webhookUrl = rows[0].webhook_url;
                try {
                    await axios.post(webhookUrl, {
                        sessionId: sessionId,
                        from: jid,
                        message: textMessage,
                        timestamp: msg.messageTimestamp
                    });
                    console.log(`[Webhook] Sent to ${webhookUrl}`);
                } catch (err) {
                    console.error(`[Webhook] Failed to send to ${webhookUrl}:`, err.message);
                }
            }
        }
    });

    activeSessions.set(sessionId, sock);
    return sock;
}


// ==========================================
// MIDDLEWARES
// ==========================================
// Check if admin is logged in
const requireAuth = (req, res, next) => {
    if (req.session.isLoggedIn) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized" });
    }
};

const requireAdmin = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: "Forbidden: Admin only" });
    }
};

async function checkOwnership(req, res, id) {
    if (req.session.role === 'admin') return true;
    const [rows] = await db.query('SELECT user_id FROM gateway_devices WHERE id = ?', [id]);
    if (rows.length === 0 || rows[0].user_id !== req.session.userId) {
        res.status(403).json({ error: "Forbidden: Not your device" });
        return false;
    }
    return true;
}

// ==========================================
// ROUTES: AUTH & FRONTEND
// ==========================================
// Serve login page statically if not logged in
app.get('/', (req, res) => {
    if (!req.session.isLoggedIn) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve other static files
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!db) return res.status(500).json({ error: "Database not ready" });

    const [rows] = await db.query('SELECT * FROM admin_users WHERE username = ?', [username]);
    
    if (rows.length > 0) {
        const user = rows[0];
        let isValid = false;
        
        // Try bcrypt compare first
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            isValid = await bcrypt.compare(password, user.password);
        } else {
            // Plaintext fallback for old accounts
            isValid = (user.password === password);
            if (isValid) {
                // Seamlessly upgrade to hashed password
                const hashed = await bcrypt.hash(password, 10);
                await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashed, user.id]);
            }
        }

        if (isValid) {
            req.session.isLoggedIn = true;
            req.session.username = username;
            req.session.userId = user.id;
            req.session.role = user.role;
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: "Username atau password salah!" });
        }
    } else {
        res.status(401).json({ success: false, message: "Username atau password salah!" });
    }
});

// --- User Management APIs ---

app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, username, role FROM admin_users');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: "Username and password required" });
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query('INSERT INTO admin_users (username, password) VALUES (?, ?)', [username, hashedPassword]);
        res.json({ success: true });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, error: "Username sudah ada" });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
    try {
        const { password } = req.body;
        const { id } = req.params;
        if (!password) return res.status(400).json({ success: false, error: "Password required" });
        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashedPassword, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        // Prevent deleting the currently logged-in user if it's the last one?
        // Let's just allow it, or check if it's the current user.
        if (id == req.session.userId) return res.status(400).json({ success: false, error: "Tidak bisa menghapus akun yang sedang dipakai login" });
        await db.query('DELETE FROM admin_users WHERE id = ?', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/user/password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ success: false, error: "Semua field harus diisi" });
        
        const [rows] = await db.query('SELECT password FROM admin_users WHERE id = ?', [req.session.userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, error: "User tidak ditemukan" });

        const user = rows[0];
        let isValid = false;
        
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            isValid = await bcrypt.compare(currentPassword, user.password);
        } else {
            isValid = (user.password === currentPassword);
        }

        if (!isValid) return res.status(401).json({ success: false, error: "Password lama salah" });

        const hashedNew = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE admin_users SET password = ? WHERE id = ?', [hashedNew, req.session.userId]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ==========================================
// ROUTES: ADMIN DASHBOARD (Protected)
// ==========================================
app.get('/api/devices', requireAuth, async (req, res) => {
    if(!db) return res.json({ devices: [] });
    let rows;
    if (req.session.role === 'admin') {
        [rows] = await db.query('SELECT * FROM gateway_devices');
    } else {
        [rows] = await db.query('SELECT * FROM gateway_devices WHERE user_id = ?', [req.session.userId]);
    }
    
    // Merge DB info with WhatsApp connection status
    const devices = rows.map(device => {
        const sock = activeSessions.get(device.id);
        const hasSessionFolder = fs.existsSync(path.join(sessionsDir, device.id));
        let status = 'disconnected';
        if (sock && sock.user) {
            status = 'connected';
        } else if (activeSessions.has(device.id)) {
            status = 'starting_or_waiting_qr';
        } else if (stoppedSessions.has(device.id)) {
            status = 'stopped';
        } else if (hasSessionFolder) {
            status = 'starting_or_waiting_qr';
        }

        let uptimeSeconds = 0;
        if (status === 'connected') {
            const sessionPath = path.join(sessionsDir, device.id);
            if (fs.existsSync(sessionPath)) {
                try {
                    const stats = fs.statSync(sessionPath);
                    const linkedAt = stats.birthtimeMs || stats.mtimeMs;
                    uptimeSeconds = Math.floor((Date.now() - linkedAt) / 1000);
                } catch(e) {
                    uptimeSeconds = sock.connectedAt ? Math.floor((Date.now() - sock.connectedAt) / 1000) : 0;
                }
            } else {
                uptimeSeconds = sock.connectedAt ? Math.floor((Date.now() - sock.connectedAt) / 1000) : 0;
            }
        }

        return { ...device, status, user: sock ? sock.user : null, uptimeSeconds };
    });

    res.json({ devices });
});

// GET Global Stats
app.get('/api/stats', requireAuth, async (req, res) => {
    if (!db) return res.status(500).json({ error: "DB not ready" });
    
    let totalSent = 0, totalReceived = 0, totalDevices = 0, connectedDevices = 0;
    
    if (req.session.role === 'admin') {
        const [rows] = await db.query('SELECT SUM(msg_sent) as total_sent, SUM(msg_received) as total_received, COUNT(*) as total_dev FROM gateway_devices');
        totalSent = rows[0].total_sent || 0;
        totalReceived = rows[0].total_received || 0;
        totalDevices = rows[0].total_dev || 0;
        
        // Count all connected sessions globally
        connectedDevices = Array.from(activeSessions.values()).filter(sock => sock && sock.user).length;
    } else {
        const [rows] = await db.query('SELECT id, msg_sent, msg_received FROM gateway_devices WHERE user_id = ?', [req.session.userId]);
        
        for (const row of rows) {
            totalSent += row.msg_sent || 0;
            totalReceived += row.msg_received || 0;
            totalDevices++;
            
            const sock = activeSessions.get(row.id);
            if (sock && sock.user) connectedDevices++;
        }
    }
    
    res.json({
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        totalDevices,
        connectedDevices,
        totalSent,
        totalReceived,
        role: req.session.role
    });
});

// GET Device Details (Contacts, Groups)
app.get('/api/device/details', requireAuth, async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "ID required" });
    if (!(await checkOwnership(req, res, id))) return;

    const sock = activeSessions.get(id);
    let groups = [];
    if (sock && sock.user) {
        try {
            const groupsDict = await Promise.race([
                sock.groupFetchAllParticipating(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetching groups')), 3000))
            ]);
            groups = Object.values(groupsDict).map(g => ({ id: g.id, name: g.subject }));
        } catch(e) {
            console.error("Group fetch error:", e.message);
        }
    }

    let contacts = [];
    if (sessionContacts.has(id)) {
        contacts = Array.from(sessionContacts.get(id).entries())
            .filter(([jid]) => jid && jid.endsWith('@s.whatsapp.net'))
            .map(([jid, name]) => ({ jid, name }));
    }

    res.json({ groups, contacts });
});

// POST Test Message from Dashboard
app.post('/api/device/test-message', requireAuth, async (req, res) => {
    const { id, number, message } = req.body;
    if (!(await checkOwnership(req, res, id))) return;
    const sock = activeSessions.get(id);
    if (!sock || !sock.user) return res.status(400).json({ error: "Device is disconnected" });

    try {
        let jid = formatPhone(number);
        
        // Resolve actual JID for personal numbers
        if (jid.endsWith('@s.whatsapp.net')) {
            const [wa] = await sock.onWhatsApp(jid);
            if (wa && wa.exists) {
                jid = wa.jid;
            } else {
                return res.status(400).json({ error: "Nomor WhatsApp tidak terdaftar" });
            }
        }

        const result = await sock.sendMessage(jid, { text: message });
        if (db) await db.query('UPDATE gateway_devices SET msg_sent = msg_sent + 1 WHERE id = ?', [id]);
        res.json({ success: true, jid: jid, result: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.post('/api/devices/add', requireAuth, async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "ID dan Nama wajib diisi" });

    const apiKey = "wa-" + require('crypto').randomBytes(16).toString('hex');

    try {
        await db.query('INSERT INTO gateway_devices (id, name, api_key, user_id) VALUES (?, ?, ?, ?)', [id, name, apiKey, req.session.userId]);
        
        // Start WA Session
        if (!activeSessions.has(id)) {
            await startSession(id);
        }

        res.json({ success: true, message: "Device ditambahkan" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/devices/action', requireAuth, async (req, res) => {
    try {
        const { id, action } = req.body;
        if (!(await checkOwnership(req, res, id))) return;
        
        if (action === 'start') {
            stoppedSessions.delete(id);
            if (!activeSessions.has(id)) {
                await startSession(id);
            }
        } else if (action === 'stop') {
            stoppedSessions.add(id);
            const sock = activeSessions.get(id);
            if (sock) {
                if (sock.ws) sock.ws.close();
                else if (sock.end) sock.end(undefined);
                activeSessions.delete(id); // Force immediate state change
            }
        } else {
            return res.status(400).json({ success: false, error: "Invalid action" });
        }
        
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/devices/update', requireAuth, async (req, res) => {
    const { id, webhook_url } = req.body;
    if (!(await checkOwnership(req, res, id))) return;
    try {
        await db.query('UPDATE gateway_devices SET webhook_url = ? WHERE id = ?', [webhook_url, id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/devices/delete', requireAuth, async (req, res) => {
    const sessionId = req.query.id;
    if (!sessionId) return res.status(400).json({ error: "Parameter 'id' is required" });
    if (!(await checkOwnership(req, res, sessionId))) return;

    // DB Remove
    await db.query('DELETE FROM gateway_devices WHERE id = ?', [sessionId]);

    // WA Logout
    const sock = activeSessions.get(sessionId);
    if (sock) {
        await sock.logout();
        activeSessions.delete(sessionId);
        qrCodes.delete(sessionId);
        authStates.delete(sessionId);
    } else {
        const sessionPath = path.join(sessionsDir, sessionId);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    res.json({ success: true });
});

app.get('/api/session/qr', requireAuth, async (req, res) => {
    const sessionId = req.query.id;
    if (!(await checkOwnership(req, res, sessionId))) return;
    const qrImage = qrCodes.get(sessionId);
    res.json({ qr: qrImage || null });
});


// ==========================================
// ROUTES: PUBLIC API (For Client Apps)
// ==========================================
// Send Message API requires API Key from headers
app.post('/api/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    const apiKey = req.headers['x-api-key'];

    if (!sessionId || !number || !message || !apiKey) {
        return res.status(400).json({ status: false, error: 'sessionId, number, message, and x-api-key header are required.' });
    }

    // Authenticate API Key
    try {
        const [rows] = await db.query('SELECT * FROM gateway_devices WHERE id = ? AND api_key = ?', [sessionId, apiKey]);
        if (rows.length === 0) {
            return res.status(401).json({ status: false, error: 'Invalid Session ID or API Key.' });
        }
    } catch(err) {
        return res.status(500).json({ status: false, error: 'Database error' });
    }

    const sock = activeSessions.get(sessionId);
    if (!sock || !sock.user) {
        return res.status(401).json({ status: false, error: `Session ${sessionId} is not connected.` });
    }

    try {
        let jid = formatPhone(number);

        // Resolve actual JID for personal numbers
        if (jid.endsWith('@s.whatsapp.net')) {
            const [wa] = await sock.onWhatsApp(jid);
            if (wa && wa.exists) {
                jid = wa.jid;
            } else {
                return res.status(400).json({ status: false, error: 'Nomor WhatsApp tidak terdaftar.' });
            }
        }

        const result = await sock.sendMessage(jid, { text: message });
        if (db) await db.query('UPDATE gateway_devices SET msg_sent = msg_sent + 1 WHERE id = ?', [sessionId]);
        res.json({ status: true, message: 'Message sent successfully!', jid: jid, result: result });
    } catch (error) {
        res.status(500).json({ status: false, error: 'Failed to send message.' });
    }
});

// ==========================================
// BOOTSTRAP
// ==========================================
async function autoStartSessions() {
    if (!db) return;
    const [rows] = await db.query('SELECT id FROM gateway_devices');
    for (const row of rows) {
        console.log(`Auto-starting saved session: ${row.id}`);
        startSession(row.id);
    }
}

app.listen(PORT, async () => {
    console.log(`🚀 WA Gateway API running on http://localhost:${PORT}`);
    await initDatabase();
    await autoStartSessions();
});
