require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'volterip';
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
});

let db;
let users;
let tarifas;

async function connectDB() {
    try {
        await client.connect();
        db = client.db(dbName);
        users = db.collection('users');
        tarifas = db.collection('tarifas');
        await users.createIndex({ username: 1 }, { unique: true });
        await users.createIndex({ extension: 1 }, { unique: true });
        await tarifas.createIndex({ extension: 1, createdAt: -1 });
        try {
            // El registro ya no usa correo: se elimina el índice único por si quedó de versiones anteriores
            await users.dropIndex('email_1');
        } catch (e) { /* el índice no existe o ya fue eliminado */ }
        console.log('Conectado a MongoDB → base de datos: ' + dbName);
    } catch (err) {
        console.error('ERROR al conectar a MongoDB:', err.message);
        process.exit(1);
    }
}

function normalizeUser(body) {
    const extension = stripCountryCode(body.extension || body.username || '', body.country || '');
    return {
        name: (body.name || '').trim(),
        username: (body.username || '').trim().toLowerCase(),
        extension,
        country: (body.country || '').trim(),
        password: body.password || '',
    };
}

// Quita el prefijo del país de un número si empieza con él.
// Ej.: país "505" + número "50576025991" -> "76025991".
function stripCountryCode(number, country) {
    let n = (number || '').replace(/\D/g, '');
    const cc = (country || '').replace(/\D/g, '');
    if (cc && n.startsWith(cc) && n.length > cc.length) {
        n = n.slice(cc.length);
    }
    return n;
}

app.use(express.static(path.join(__dirname, 'views')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, db: dbName });
});

app.get('/api/ping', (req, res) => {
    res.json({ ok: true, t: Date.now() });
});

// ---------- REGISTRO ----------
app.post('/api/register', async (req, res) => {
    try {
        const { name, username, extension, country, password } = normalizeUser(req.body);

        if (!name || !username || !extension || !password) {
            return res.status(400).json({ ok: false, error: 'Completa todos los campos obligatorios.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
        }
        if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
            return res.status(400).json({ ok: false, error: 'El nombre de usuario solo puede contener letras, números, guiones y puntos.' });
        }

        // Verificar si el usuario O la extensión ya existen
        const dupUser = await users.findOne({ $or: [{ username }, { extension }] });
        if (dupUser) {
            const ocupado = dupUser.username === username ? 'El usuario' : 'La extensión';
            return res.status(409).json({
                ok: false,
                error: ocupado + ' "' + (dupUser.username === username ? username : extension) + '" ya está ocupada. Elige otro usuario o extensión.',
                conflict: dupUser.username === username ? 'username' : 'extension'
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const user = {
            name,
            username,
            extension,
            country,
            passwordHash,
            status: 'disponible',
            createdAt: new Date(),
        };

        try {
            const result = await users.insertOne(user);
            return res.status(201).json({
                ok: true,
                msg: 'Cuenta creada correctamente.',
                user: { id: result.insertedId, name, username, extension, country }
            });
        } catch (e) {
            if (e.code === 11000) {
                return res.status(409).json({ ok: false, error: 'El usuario o la extensión ya está ocupada. No se pudo crear la cuenta.', conflict: 'unique' });
            }
            throw e;
        }
    } catch (err) {
        console.error('Error en /register:', err);
        res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
    }
});

// ---------- LOGIN ----------
// Códigos de marcado conocidos para poder buscar la extensión sin su prefijo de país
const KNOWN_COUNTRY_CODES = ['505', '506', '503', '502', '504', '507', '593', '591', '595', '598', '351',
    '52', '57', '54', '56', '51', '58', '55', '34', '44', '33', '49', '39', '53', '1'];

function withoutCountryPrefix(number) {
    let n = (number || '').replace(/\D/g, '');
    const sorted = [...KNOWN_COUNTRY_CODES].sort((a, b) => b.length - a.length);
    for (const cc of sorted) {
        if (n.length > cc.length && n.startsWith(cc)) {
            n = n.slice(cc.length);
            break;
        }
    }
    return n;
}

app.post('/api/login', async (req, res) => {
    try {
        const usuario = (req.body.user || '').trim().toLowerCase();
        const password = req.body.password || '';

        if (!usuario || !password) {
            return res.status(400).json({ ok: false, error: 'Ingresa tu usuario y contraseña.' });
        }

        // Busca por usuario o por extensión (con o sin el prefijo del país)
        const bareExt = withoutCountryPrefix(usuario);
        let found = await users.findOne({
            $or: [{ username: usuario }, { extension: usuario }, { extension: bareExt }]
        });
        // Respaldo: si no se encontró y el valor era numérico, buscar el número sin prefijo
        if (!found && /\d/.test(usuario)) {
            const extOnly = (usuario.match(/\d+/) || [''])[0];
            found = await users.findOne({ extension: extOnly });
        }
        if (!found) {
            return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
        }

        const valid = await bcrypt.compare(password, found.passwordHash);
        if (!valid) {
            return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
        }

        return res.json({
            ok: true,
            msg: 'Bienvenido ' + found.name,
            user: { id: found._id, name: found.name, username: found.username, extension: found.extension, country: found.country || '' }
        });
    } catch (err) {
        console.error('Error en /login:', err);
        res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
    }
});

app.use('/views', express.static(path.join(__dirname, 'views')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

// ================= TARIFAS / TICKETS =================
const RATE_PER_SEC = 0.08;   // C$0.08/s
const RATE_PER_MIN = RATE_PER_SEC * 60;   // C$4.80/min
const RATE_PER_HOUR = RATE_PER_MIN * 60;  // C$288/h
const RATES = { perSecond: RATE_PER_SEC, perMinute: RATE_PER_MIN, perHour: RATE_PER_HOUR };

function calcCost(seconds) {
    return Math.round(seconds * RATE_PER_SEC * 100) / 100;
}

app.get('/api/rates', (req, res) => {
    res.json({ ok: true, rates: RATES });
});

// Guardar el registro de una llamada en la colección "tarifas"
app.post('/api/tarifas', async (req, res) => {
    try {
        const { caller, callee, seconds, type } = req.body;
        if (!caller || !callee) {
            return res.status(400).json({ ok: false, error: 'Faltan datos de la llamada.' });
        }
        const secs = Math.max(0, Math.round(Number(seconds) || 0));
        const t = ['out', 'in', 'missed'].includes(type) ? type : 'out';
        // Solo las salidas contestadas generan cobro
        const cost = t === 'out' && secs > 0 ? calcCost(secs) : 0;
        const extension = t === 'out' ? caller : callee; // dueño del registro
        const record = {
            extension,
            caller,
            callee,
            seconds: secs,
            cost,
            type: t,
            createdAt: new Date(),
        };
        const r = await tarifas.insertOne(record);
        res.status(201).json({ ok: true, record: { _id: r.insertedId, ...record } });
    } catch (err) {
        console.error('Error en /api/tarifas:', err);
        res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
    }
});

// Historial de tarifas de un usuario
app.get('/api/tarifas', async (req, res) => {
    try {
        const user = (req.query.user || '').trim();
        if (!user) return res.status(400).json({ ok: false, error: 'Falta el usuario.' });
        const docs = await tarifas.find({ extension: user }).sort({ createdAt: -1 }).limit(200).toArray();
        res.json({ ok: true, records: docs });
    } catch (err) {
        console.error('Error en GET /api/tarifas:', err);
        res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
    }
});

// Limpiar el historial de tarifas de un usuario
app.delete('/api/tarifas', async (req, res) => {
    try {
        const user = (req.query.user || '').trim();
        if (!user) return res.status(400).json({ ok: false, error: 'Falta el usuario.' });
        const r = await tarifas.deleteMany({ extension: user });
        res.json({ ok: true, deleted: r.deletedCount });
    } catch (err) {
        console.error('Error en DELETE /api/tarifas:', err);
        res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
    }
});

// ================= SOCKET.IO · TELEFONÍA =================
// Cada extensión puede tener varios sockets a la vez (p. ej. mismo usuario
// logueado en dos dispositivos o en dos pestañas). Al llamar, timbran todos.
const online = new Map(); // extensión -> Set de socket ids
const calls = new Map();  // callId -> estado de la llamada
const NO_ANSWER_MS = 10000;

function onlineSockets(ext) {
    const set = online.get(ext);
    if (!set) return [];
    return [...set].filter((id) => {
        const s = io.sockets.sockets.get(id);
        return s && s.connected;
    });
}

io.on('connection', (socket) => {
    socket.on('register', (data) => {
        const ext = (data && data.extension || '').toString().trim();
        if (!ext) return;
        socket.data.extension = ext;
        socket.data.userName = (data.name || '').trim();
        let set = online.get(ext);
        if (!set) { set = new Set(); online.set(ext, set); }
        set.add(socket.id);
        io.emit('presence', { extension: ext, online: true });
        console.log('En línea:', ext, '(' + socket.data.userName + ') · socket ' + socket.id.slice(0, 6));

        // Si hay una llamada sonando para esta extensión, reenviar el timbre a este socket
        for (const [cid, c] of calls.entries()) {
            if (c.callee === ext && c.state === 'ringing' && !c.calleeSockets.has(socket.id)) {
                c.calleeSockets.add(socket.id);
                io.to(socket.id).emit('incoming_call', { callId: cid, from: c.caller, fromName: c.callerName || '' });
            }
        }
    });

    // Pide la lista actual de extensiones en línea (para refrescar la web)
    socket.on('presence_list', () => {
        const seen = new Set();
        const list = [];
        for (const ext of online.keys()) {
            const ids = onlineSockets(ext);
            if (!ids.length || seen.has(ext)) continue;
            seen.add(ext);
            let name = socket.data.userName || '';
            const anySocket = io.sockets.sockets.get(ids[0]);
            if (anySocket && anySocket.data) name = anySocket.data.userName || name;
            list.push({ extension: ext, name });
        }
        socket.emit('presence_list', { list });
    });

    socket.on('call', (dest) => {
        const src = socket.data.extension;
        if (!src) return;
        const targetSockets = onlineSockets(dest);

        if (!targetSockets.length) {
            socket.emit('call_result', { ok: false, reason: 'offline', dest });
            return;
        }

        const callId = src + ':' + dest + ':' + Date.now();
        const call = {
            callId,
            caller: src,
            callee: dest,
            callerName: socket.data.userName,
            callerSocket: socket.id,
            calleeSockets: new Set(targetSockets),
            calleeSocket: null, // socket que respondió
            state: 'ringing',
            timeout: null,
        };

        calls.set(callId, call);
        socket.emit('call_result', { ok: true, callId, state: 'ringing', dest });
        for (const id of targetSockets) {
            io.to(id).emit('incoming_call', { callId, from: src, fromName: socket.data.userName });
        }

        call.timeout = setTimeout(() => {
            const c = calls.get(callId);
            if (!c || c.state !== 'ringing') return;
            c.state = 'no_answer';
            io.to(c.callerSocket).emit('call_ended', { callId, reason: 'no_answer' });
            for (const id of c.calleeSockets) {
                io.to(id).emit('incoming_stop', { callId, reason: 'no_answer', from: c.caller });
            }
            calls.delete(callId);
        }, NO_ANSWER_MS);
    });

    socket.on('answer', (data) => {
        const call = calls.get(data.callId);
        if (!call || call.state !== 'ringing') return;
        clearTimeout(call.timeout);
        call.state = 'active';
        call.calleeSocket = socket.id;
        io.to(call.callerSocket).emit('call_accepted', { callId: call.callId, with: call.callee });
        // Avisar a los demás sockets de la misma extensión que dejen de timbrar
        for (const id of call.calleeSockets) {
            if (id !== socket.id) io.to(id).emit('incoming_stop', { callId: call.callId, reason: 'answered', from: call.caller });
        }
        socket.emit('call_connected', { callId: call.callId, with: call.caller });
    });

    socket.on('reject', (data) => {
        const call = calls.get(data.callId);
        if (!call) return;
        clearTimeout(call.timeout);
        call.state = 'rejected';
        io.to(call.callerSocket).emit('call_ended', { callId: call.callId, reason: 'rejected' });
        for (const id of call.calleeSockets) {
            io.to(id).emit('incoming_stop', { callId: call.callId, reason: 'rejected' });
        }
        calls.delete(call.callId);
    });

    socket.on('end_call', (data) => {
        const call = calls.get(data.callId);
        if (!call) return;
        clearTimeout(call.timeout);
        const wasRinging = call.state === 'ringing';
        call.state = 'ended';
        const calleeIds = wasRinging
            ? call.calleeSockets
            : (call.calleeSocket ? new Set([call.calleeSocket]) : call.calleeSockets);
        for (const id of calleeIds) {
            io.to(id).emit(wasRinging ? 'incoming_stop' : 'call_ended', {
                callId: call.callId, reason: wasRinging ? 'caller_hangup' : 'ended', from: call.caller,
            });
        }
        io.to(call.callerSocket).emit('call_ended', { callId: call.callId, reason: 'ended' });
        calls.delete(call.callId);
    });

    // ---------- Retransmisión WebRTC (ofertas, respuestas e ICE) ----------
    const relayRTC = (eventName, data) => {
        const call = calls.get(data.callId);
        if (!call) return;
        // El llamante reenvía al socket que respondió; el receptor al socket llamante
        let peer;
        if (socket.id === call.callerSocket) {
            peer = call.calleeSocket || (call.calleeSockets.size ? [...call.calleeSockets][0] : null);
        } else {
            peer = call.callerSocket;
        }
        if (!peer) return;
        io.to(peer).emit(eventName, { callId: data.callId, sdp: data.sdp, candidate: data.candidate });
    };

    socket.on('rtc_offer', (data) => relayRTC('rtc_offer', data));
    socket.on('rtc_answer', (data) => relayRTC('rtc_answer', data));
    socket.on('rtc_ice', (data) => relayRTC('rtc_ice', data));

    socket.on('disconnect', () => {
        const ext = socket.data.extension;
        if (ext) {
            const set = online.get(ext);
            if (set) {
                set.delete(socket.id);
                if (!set.size) {
                    online.delete(ext);
                    io.emit('presence', { extension: ext, online: false });
                    console.log('Fuera de línea:', ext);
                }
            }
        }
        // Terminar llamadas relacionadas con este socket
        for (const [callId, call] of calls.entries()) {
            const isCaller = call.callerSocket === socket.id;
            const isRinging = call.state === 'ringing' && call.calleeSockets &&
                              call.calleeSockets.has(socket.id);
            const isActive = call.state === 'active' && call.calleeSocket === socket.id;
            if (!isCaller && !isRinging && !isActive) continue;

            clearTimeout(call.timeout);
            if (isCaller) {
                const ids = call.state === 'ringing' ? call.calleeSockets : new Set([call.calleeSocket]);
                for (const id of ids) {
                    if (id) io.to(id).emit(call.state === 'ringing' ? 'incoming_stop' : 'call_ended', { callId, reason: 'ended' });
                }
                calls.delete(callId);
            } else if (isRinging) {
                // Se cayó uno de los que timbraban: si no queda ninguno, terminar
                call.calleeSockets.delete(socket.id);
                if (!call.calleeSockets.size) {
                    call.state = 'no_answer';
                    io.to(call.callerSocket).emit('call_ended', { callId, reason: 'no_answer' });
                    calls.delete(callId);
                }
            } else if (isActive) {
                io.to(call.callerSocket).emit('call_ended', { callId, reason: 'ended' });
                calls.delete(callId);
            }
        }
    });
});

connectDB().then(() => {
    server.listen(PORT, () => console.log('Servidor volterIP escuchando en http://localhost:' + PORT));
});