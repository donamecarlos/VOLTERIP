const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';

const log = (who, msg) => console.log('[' + who + '] ' + msg);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connectClient(name) {
    const s = io(URL);
    s.on('connect', () => {
        log(name, 'conectado · registrando ' + name);
        s.emit('register', { extension: name, name });
    });
    return s;
}

async function main() {
    const a = connectClient('1001');
    const b = connectClient('1002');

    a.on('incoming_call', () => log('A', 'incoming_call (no debería)'));
    b.on('incoming_call', (data) => {
        log('B', 'INCOMING CALL de ' + data.from + ' callId=' + data.callId);
        setTimeout(() => {
            log('B', 'contestando...');
            b.emit('answer', { callId: data.callId });
        }, 500);
    });

    a.on('call_result', (data) => log('A', 'call_result: ' + JSON.stringify(data)));
    a.on('call_accepted', (data) => {
        log('A', 'CALL ACCEPTED, en llamada con ' + data.with);
        setTimeout(() => {
            log('A', 'colgando...');
            a.emit('end_call', { callId: data.callId });
        }, 2000);
    });
    a.on('call_ended', (data) => log('A', 'call_ended: ' + data.reason));
    b.on('call_connected', (data) => log('B', 'CALL CONNECTED con ' + data.with));
    b.on('call_ended', (data) => log('B', 'call_ended: ' + data.reason));
    b.on('incoming_stop', (data) => log('B', 'incoming_stop: ' + data.reason));

    // Caso 1: llamada normal contestada
    await sleep(1000);
    log('A', 'lanzando llamada a 1002');
    a.emit('call', '1002');

    await sleep(5000);

    // Caso 2: llamada a una extensión que no está en línea
    log('A', 'lanzando llamada a 9999 (offline)');
    a.emit('call', '9999');
    await sleep(1500);

    // Caso 3: llamada no contestada (10s)
    log('B', 'B se desconecta para probar no_answer con C');
    b.disconnect();
    const c = connectClient('1003');
    c.on('incoming_call', (data) => log('C', 'incoming_call (no contestará)'));
    c.on('incoming_stop', (data) => log('C', 'incoming_stop: ' + data.reason));
    await sleep(800);
    log('A', 'llamando a 1003 (no contestará)');
    a.emit('call', '1003');
    await sleep(12500);

    a.disconnect();
    c.disconnect();
    console.log('TEST FINALIZADO');
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });