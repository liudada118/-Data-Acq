const check = (condition, message) => { if (!condition) throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, token, bytes) {
  const response = await fetch(route, {
    method: body !== undefined || bytes ? 'POST' : 'GET',
    headers: { ...(body !== undefined || bytes ? { 'Content-Type': bytes ? 'application/octet-stream' : 'application/json' } : {}),
      ...(token ? { 'X-Camera-Token': token } : {}) },
    body: bytes || (body !== undefined ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  check(response.ok, `${route}: ${data.error || response.status}`); return data;
}
async function withDeadline(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 12000); })]); }
  finally { clearTimeout(timer); }
}
async function run() {
  check(window.isSecureContext, 'AudioWorklet fixture must be a secure loopback origin');
  // No media capture APIs are used. This oscillator exists only inside the Web Audio graph.
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  let oscillator, worklet, session, lease;
  try {
    await context.resume(); check(context.state === 'running', 'AudioContext did not resume');
    await context.audioWorklet.addModule('/audio/pcm-capture.worklet.js');
    const sampleRate = context.sampleRate;
    lease = await api('/api/cameras/register', { kind: 'audio', instance_id: 'oscillator', label: 'Synthetic 1000 Hz smoke',
      sample_rate: sampleRate, channels: 1, encoding: 'pcm_s16le' });
    session = await api('/api/sessions/start', { name: 'Chromium AudioWorklet synthetic sine smoke', device_ids: [lease.device.id],
      camera_sources: [{ instance_id: 'oscillator', token: lease.token, mime_type: 'audio/wav' }] });
    worklet = new AudioWorkletNode(context, 'synapse-pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    const amplitude = context.createGain(); amplitude.gain.value = 0.25;
    oscillator = context.createOscillator(); oscillator.frequency.value = 1000;
    oscillator.connect(amplitude); amplitude.connect(worklet); worklet.connect(analyser); analyser.connect(context.destination);
    let resolveStarted, resolveStopped, resolveEnough, rejectFailure;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const stopped = new Promise(resolve => { resolveStopped = resolve; });
    const enough = new Promise(resolve => { resolveEnough = resolve; });
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    const captureId = crypto.randomUUID(), pieces = [];
    let received = 0, acknowledged = 0, payloadBytes = 0, tail = Promise.resolve();
    const fail = error => { rejectFailure(error instanceof Error ? error : new Error(String(error))); };
    worklet.onprocessorerror = () => fail('AudioWorklet processorerror');
    worklet.port.onmessage = event => {
      const message = event.data;
      try {
        check(message.capture_id === captureId, 'Worklet capture ID mismatch');
        if (message.type === 'started') { resolveStarted(); return; }
        if (message.type === 'stopped') { resolveStopped(); return; }
        if (message.type === 'error') throw new Error(message.error);
        if (message.type !== 'chunk') return;
        check(message.index === received && message.buffer instanceof ArrayBuffer && message.buffer.byteLength % 2 === 0, 'Invalid worklet PCM chunk');
        const index = received++, bytes = message.buffer;
        pieces.push(new Uint8Array(bytes).slice());
        tail = tail.then(async () => {
          const result = await api(`/api/cameras/oscillator/chunks?session_id=${session.session_id}&index=${index}`, undefined, lease.token, bytes);
          check(result.next_index === index + 1 && result.payload_bytes === payloadBytes + bytes.byteLength, 'Backend PCM acknowledgement mismatch');
          payloadBytes += bytes.byteLength; acknowledged++;
          worklet.port.postMessage({ type: 'ack', capture_id: captureId, index });
          if (acknowledged >= 5) resolveEnough();
        });
        tail.catch(fail);
      } catch (error) { fail(error); }
    };
    oscillator.start();
    const startedAt = new Date().toISOString(), startClock = performance.now();
    worklet.port.postMessage({ type: 'start', capture_id: captureId });
    await withDeadline(Promise.race([started, failure]), 'worklet started');
    await withDeadline(Promise.race([enough, failure]), 'five PCM upload acknowledgements');
    await wait(63);
    worklet.port.postMessage({ type: 'stop', capture_id: captureId });
    await withDeadline(Promise.race([stopped, failure]), 'worklet stopped and tail flushed');
    await withDeadline(Promise.race([tail, failure]), 'final PCM upload');
    const stoppedAt = new Date().toISOString(), clientDuration = performance.now() - startClock;
    check(received === acknowledged && received >= 6, 'Worklet tail did not reach the backend');
    const output = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(output);
    check(output.every(value => value === 0), 'Capture worklet unexpectedly produced audible output');
    await api('/api/cameras/oscillator/finalize', { session_id: session.session_id, next_index: acknowledged, bytes: payloadBytes,
      started_at: startedAt, stopped_at: stoppedAt, duration_ms: clientDuration }, lease.token);
    const saved = await api('/api/sessions/stop', { session_id: session.session_id });
    check(saved.session.status === 'complete' && saved.session.streams.length === 0, 'Browser PCM session did not finish as media-only');
    const media = saved.session.media_streams[0];
    const pcm = new Uint8Array(payloadBytes); let offset = 0;
    for (const piece of pieces) { pcm.set(piece, offset); offset += piece.byteLength; }
    const wavResponse = await fetch(`/api/files/${session.session_id}/${media.file}`);
    check(wavResponse.ok && wavResponse.headers.get('Content-Type') === 'audio/wav', 'WAV download failed');
    const wave = new Uint8Array(await wavResponse.arrayBuffer()), header = new DataView(wave.buffer);
    check(new TextDecoder().decode(wave.subarray(0, 4)) === 'RIFF' && header.getUint32(4, true) === payloadBytes + 36, 'Invalid RIFF size');
    check(header.getUint16(20, true) === 1 && header.getUint16(22, true) === 1 && header.getUint32(24, true) === sampleRate && header.getUint16(34, true) === 16, 'Invalid PCM WAV layout');
    check(header.getUint32(40, true) === payloadBytes && wave.length === payloadBytes + 44, 'WAV length mismatch');
    check(pcm.every((value, index) => wave[index + 44] === value), 'Uploaded PCM bytes changed during storage');
    const samples = new DataView(pcm.buffer), count = payloadBytes / 2, crossings = [];
    let squares = 0, peak = 0;
    for (let index = 0; index < count; index++) {
      const value = samples.getInt16(index * 2, true) / 32768; squares += value * value; peak = Math.max(peak, Math.abs(value));
      if (index && samples.getInt16((index - 1) * 2, true) <= 0 && value > 0) crossings.push(index);
    }
    const frequency = (crossings.length - 1) * sampleRate / (crossings.at(-1) - crossings[0]), rms = Math.sqrt(squares / count);
    check(Math.abs(frequency - 1000) < 1, `Captured frequency ${frequency} differs from generated 1000 Hz`);
    check(Math.abs(rms - 0.25 / Math.sqrt(2)) < 0.003 && Math.abs(peak - 0.25) < 0.002, 'PCM amplitude or quantization is wrong');
    check(media.sample_count === count && media.duration_ms === count / sampleRate * 1000, 'Duration was not derived from exact sample count');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', pcm));
    return { sessionId: session.session_id, mediaFile: media.file, chunks: acknowledged, sampleRate, sampleCount: count,
      payloadBytes, durationMs: media.duration_ms, clientDurationMs: clientDuration, frequencyHz: frequency, rms, peak,
      fullChunkFrames: Math.round(sampleRate / 4), finalChunkFrames: pieces.at(-1).byteLength / 2,
      pcmSha256: [...hash].map(value => value.toString(16).padStart(2, '0')).join(''), outputSilent: true,
      audioContextState: context.state, userAgent: navigator.userAgent };
  } finally {
    try { oscillator?.stop(); } catch {}
    try { worklet?.port.postMessage({ type: 'dispose' }); worklet?.disconnect(); } catch {}
    await context.close();
    if (lease) await api('/api/cameras/oscillator/disconnect', {}, lease.token).catch(() => {});
  }
}
run().then(result => window.microphoneSmoke.complete(result), error => window.microphoneSmoke.fail(error.stack || error.message));
