const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (w, m) => console.log('[' + w + '] ' + m);

function mk(name) {
    const s = io(URL);
    s.on('connect', () => { log(name, 'conectado'); s.emit('register', { extension: name, name }); });
    s.__ringCallId = null;
    s.__activeCallId = null;
    s.on('incoming_call', (d) => { s.__ringCallId = d.callId; log(name, 'TIMBRE de ' + d.from); });
    s.on('call_accepted', (d) => { s.__activeCallId = d.callId; log(name, 'ACEPTADO callId=' + d.callId); });
    s.on('call_connected', (d) => { s.__activeCallId = d.callId; log(name, 'CONECTADO callId=' + d.callId); });
    s.on('call_result', (d) => { if (d.ok) s.__outCallId = d.callId; log(name, 'call_result ok=' + d.ok + (d.callId ? ' callId=' + d.callId : ' reason=' + d.reason)); });
    s.on('call_ended', (d) => log(name, 'call_ended reason=' + d.reason));
    s.on('incoming_stop', (d) => log(name, 'incoming_stop reason=' + d.reason + ' from=' + d.from));
    return s;
}

async function main() {
    const a = mk('3001');
    const b = mk('3002');
    await sleep(800);

    // CASO 1: A llama, B no contesta, A cuelga durante el timbre
    log('--- CASO 1: A cuelga durante el timbre');
    a.emit('call', '3002');
    await sleep(1200);
    a.emit('end_call', { callId: a.__outCallId });
    await sleep(800);

    // CASO 2: A llama, B contesta, A cuelga (llamada activa)
    log('--- CASO 2: activa, colgar A');
    a.emit('call', '3002');
    await sleep(1200);
    b.emit('answer', { callId: b.__ringCallId });
    await sleep(1500);
    a.emit('end_call', { callId: a.__activeCallId });
    await sleep(800);

    // CASO 3: A llama, B contesta y B cuelga (llamada activa)
    log('--- CASO 3: activa, colgar B');
    a.__activeCallId = null; b.__ringCallId = null;
    a.emit('call', '3002');
    await sleep(1200);
    b.emit('answer', { callId: b.__ringCallId });
    await sleep(1500);
    b.emit('end_call', { callId: b.__activeCallId });
    await sleep(800);

    // CASO 4: no contestar (10s)
    log('--- CASO 4: no contestar (10s)');
    a.__outCallId = null;
    b.__ringCallId = null;
    a.emit('call', '3002');
    await sleep(1200);
    await sleep(11000);

    a.disconnect(); b.disconnect();
    console.log('TEST FINALIZADO');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });