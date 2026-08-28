import fs from 'fs';
import path from 'path';
import { Mp3Encoder } from '@breezystack/lamejs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 44100;
const OUT_DIR = path.join(__dirname, '..', 'sounds');

function tone(freq, durationSec, gain = 0.5) {
    const n = Math.floor(durationSec * SAMPLE_RATE);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        samples[i] = Math.sin(2 * Math.PI * freq * (i / SAMPLE_RATE)) * gain;
    }
    return samples;
}

function silence(durationSec) {
    return new Float32Array(Math.floor(durationSec * SAMPLE_RATE));
}

function concat(parts) {
    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function applyFade(samples, fadeSec = 0.01) {
    const n = Math.floor(fadeSec * SAMPLE_RATE);
    for (let i = 0; i < n && i < samples.length; i++) {
        samples[i] *= i / n;
        samples[samples.length - 1 - i] *= i / n;
    }
    return samples;
}

function encodeMp3(floatSamples) {
    const intSamples = new Int16Array(floatSamples.length);
    for (let i = 0; i < floatSamples.length; i++) {
        intSamples[i] = Math.max(-1, Math.min(1, floatSamples[i])) * 32767;
    }
    const encoder = new Mp3Encoder(1, SAMPLE_RATE, 128);
    const chunks = [];
    const block = 1152 * 100;
    for (let i = 0; i < intSamples.length; i += block) {
        const frame = encoder.encodeBuffer(intSamples.subarray(i, i + block));
        if (frame.length) chunks.push(Buffer.from(frame));
    }
    const end = encoder.flush();
    if (end.length) chunks.push(Buffer.from(end));
    return Buffer.concat(chunks);
}

function save(name, floatSamples) {
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, encodeMp3(applyFade(floatSamples)));
    console.log('Generado: ' + file + ' (' + Math.round(fs.statSync(file).size / 1024) + ' KB)');
}

// 1) Llamada entrante: tono de timbre, ráfagas de 1s on / 1.5s off (2 ciclos)
const ringParts = [];
for (let i = 0; i < 2; i++) {
    ringParts.push(tone(440, 1.0, 0.5));
    ringParts.push(silence(1.5));
}
save('llamada_entrante.mp3', concat(ringParts));

// 2) No contesta: 3 bip rápidos (800 Hz, 0.35s on / 0.25s off) + cierre
save('no_contesta.mp3', concat([
    tone(800, 0.35, 0.5), silence(0.25),
    tone(800, 0.35, 0.5), silence(0.25),
    tone(800, 0.35, 0.5), silence(0.25),
    tone(1200, 0.5, 0.5),
]));

// 3) No en línea: zumbido grave descendente (600→200 Hz) doble
function descendingTone(fromFreq, toFreq, durationSec, gain = 0.5) {
    const n = Math.floor(durationSec * SAMPLE_RATE);
    const samples = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
        const f = fromFreq + (toFreq - fromFreq) * (i / n);
        phase += 2 * Math.PI * f / SAMPLE_RATE;
        samples[i] = Math.sin(phase) * gain;
    }
    return samples;
}
save('no_en_linea.mp3', concat([
    descendingTone(600, 300, 0.5, 0.45), silence(0.18),
    descendingTone(600, 300, 0.5, 0.45), silence(0.18),
    descendingTone(450, 220, 0.7, 0.45),
]));