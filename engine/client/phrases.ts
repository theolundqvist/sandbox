/** Cuts a mic's samples into spoken phrases; the floor is the median level of the last seconds before one, so game music and its beats count as quiet. */
export function phrases(rate: number, onPhrase: (wav: Blob) => void) {
  const PRE_MS = 300;
  const ONSET_MS = 150;
  const END_MS = 700;
  const MIN_LOUD_MS = 400;
  const MAX_MS = 15_000;
  const FLOOR_MS = 2_000;
  const levels: number[] = [];
  let floor = 0;
  let last = 0;
  let high = 0;
  let previous = 0;
  let voice = 0;
  let before: Float32Array[] = [];
  let phrase: Float32Array[] | null = null;
  let onsetMs = 0;
  let loudMs = 0;
  let quietMs = 0;
  let phraseMs = 0;
  return (samples: Float32Array) => {
    const ms = (samples.length / rate) * 1000;
    let sum = 0;
    // A high-pass leaves out hum and handling rumble.
    for (const x of samples) {
      high = 0.95 * (high + x - last);
      last = x;
      sum += high * high;
    }
    const level = Math.sqrt(sum / samples.length);
    if (!phrase) {
      levels.push(level);
      if (levels.length * ms > FLOOR_MS) levels.shift();
      floor = levels.toSorted((a, b) => a - b)[levels.length >> 1]!;
    }
    // A voice holds its level where a beat or a pluck decays at once, and drums under a phrase stay far below the voice in it.
    const loud =
      (phrase ? level > Math.max(0.01, floor * 1.8, voice * 0.3) : level > Math.max(0.01, floor * 2.5) && level > previous * 0.8) && voiced(samples, rate);
    previous = level;
    voice = loud ? Math.max(phrase ? voice * 0.98 : voice, level) : phrase ? voice : 0;
    if (!phrase) {
      before.push(samples);
      while (before.length > 1 && (before.length - 1) * ms > PRE_MS) before.shift();
      onsetMs = loud ? onsetMs + ms : 0;
      if (onsetMs < ONSET_MS) return;
      phrase = before;
      before = [];
      phraseMs = phrase.length * ms;
      loudMs = onsetMs;
      quietMs = 0;
      return;
    }
    phrase.push(samples);
    phraseMs += ms;
    if (loud) {
      loudMs += ms;
      quietMs = 0;
    } else quietMs += ms;
    if (quietMs < END_MS && phraseMs < MAX_MS) return;
    if (loudMs >= MIN_LOUD_MS) onPhrase(wav(phrase, rate));
    phrase = null;
    onsetMs = 0;
  };
}

/** Whether a frame repeats at a voice's pitch, 80 to 400 Hz, which noise like explosions and footsteps never does. */
function voiced(samples: Float32Array, rate: number) {
  const step = Math.round(rate / 8_000);
  const x = new Float32Array(Math.floor(samples.length / step));
  for (let i = 0; i < x.length; i++) for (let j = 0; j < step; j++) x[i]! += samples[i * step + j]! / step;
  let best = 0;
  for (let lag = 20; lag <= 100; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < x.length; i++) {
      xy += x[i]! * x[i + lag]!;
      xx += x[i]! * x[i]!;
      yy += x[i + lag]! * x[i + lag]!;
    }
    best = Math.max(best, xy / Math.sqrt(xx * yy || 1));
  }
  return best > 0.6;
}

/** 16 kHz mono 16-bit WAV, which every speech-to-text provider takes. */
function wav(chunks: Float32Array[], rate: number) {
  const step = rate / 16_000;
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) all.set(c, (at += c.length) - c.length);
  const count = Math.floor(all.length / step);
  const view = new DataView(new ArrayBuffer(44 + count * 2));
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    // Averaging each step's samples keeps high frequencies from folding into speech.
    let sum = 0;
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    for (let j = from; j < to; j++) sum += all[j]!;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sum / (to - from))) * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}
