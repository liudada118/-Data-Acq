// Loopback-only test fixture. Never part of the sensor catalog or packaged app.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { MEDIA_EXECUTABLE } from '../../src/plugins/media.mjs';

async function encodedFrame() {
  const child = spawn(MEDIA_EXECUTABLE, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=red:s=16x16:r=10', '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-tune', 'zerolatency', '-x264-params', 'keyint=1:repeat-headers=1', '-f', 'h264', 'pipe:1'],
  { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const chunks = []; let stderr = '', size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('H264 fixture encode timeout')); }, 5000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) child.kill(); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 1000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`H264 fixture encode failed: ${stderr}`)); });
  });
}

export async function createRtspFixture({ silent = false } = {}) {
  const encoded = await encodedFrame();
  const starts = [];
  for (let i = 0; i + 3 < encoded.length; i++) {
    if (encoded[i] === 0 && encoded[i + 1] === 0 && encoded[i + 2] === 1) { starts.push({ start: i, body: i + 3 }); i += 2; }
    else if (encoded[i] === 0 && encoded[i + 1] === 0 && encoded[i + 2] === 0 && encoded[i + 3] === 1) { starts.push({ start: i, body: i + 4 }); i += 3; }
  }
  const nals = starts.map((entry, i) => encoded.subarray(entry.body, starts[i + 1]?.start ?? encoded.length));
  const sps = nals.find(nal => (nal[0] & 31) === 7), pps = nals.find(nal => (nal[0] & 31) === 8);
  if (!sps || !pps || nals.some(nal => nal.length > 1400)) throw new Error('Invalid RTP fixture frame');
  const sockets = new Set(); let connections = 0, sent = 0;
  const server = net.createServer(socket => {
    connections++; sockets.add(socket);
    let input = Buffer.alloc(0), interval, sequence = 100, timestamp = 0, channel = 0;
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); clearInterval(interval); });
    function reply(cseq, headers = {}, body = '') {
      const fields = { CSeq: cseq, Server: 'Loopback test fixture', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) };
      socket.write(`RTSP/1.0 200 OK\r\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n${body}`);
    }
    function frame() {
      for (let i = 0; i < nals.length; i++) {
        const packet = Buffer.alloc(16 + nals[i].length);
        packet[0] = 36; packet[1] = channel; packet.writeUInt16BE(packet.length - 4, 2);
        packet[4] = 0x80; packet[5] = 96 | (i === nals.length - 1 ? 0x80 : 0);
        packet.writeUInt16BE(sequence++ & 0xffff, 6); packet.writeUInt32BE(timestamp >>> 0, 8); packet.writeUInt32BE(12345, 12);
        nals[i].copy(packet, 16); socket.write(packet);
      }
      timestamp += 9000; sent++;
    }
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length) {
        if (input[0] === 36) {
          if (input.length < 4 || input.length < 4 + input.readUInt16BE(2)) return;
          input = input.subarray(4 + input.readUInt16BE(2)); continue;
        }
        const end = input.indexOf('\r\n\r\n'); if (end < 0) return;
        const request = input.subarray(0, end).toString(), lines = request.split('\r\n');
        const headers = Object.fromEntries(lines.slice(1).map(line => { const pos = line.indexOf(':'); return [line.slice(0, pos).toLowerCase(), line.slice(pos + 1).trim()]; }));
        const size = end + 4 + Number(headers['content-length'] ?? 0); if (input.length < size) return;
        input = input.subarray(size);
        const method = lines[0].split(' ')[0];
        if (method === 'OPTIONS') reply(headers.cseq, { Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER' });
        else if (method === 'DESCRIBE') reply(headers.cseq, { 'Content-Type': 'application/sdp', 'Content-Base': `${url}/` },
          ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Test-only fixture', 'c=IN IP4 127.0.0.1', 't=0 0', 'a=control:*',
            'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H264/90000', `a=fmtp:96 packetization-mode=1;sprop-parameter-sets=${sps.toString('base64')},${pps.toString('base64')}`, 'a=control:trackID=0', ''].join('\r\n'));
        else if (method === 'SETUP') {
          channel = Number(/interleaved=(\d+)-/.exec(headers.transport)?.[1] ?? 0);
          reply(headers.cseq, { Transport: headers.transport, Session: 'fixture-session;timeout=60' });
        } else if (method === 'PLAY') {
          reply(headers.cseq, { Session: 'fixture-session', Range: 'npt=0.000-', 'RTP-Info': `url=${url}/trackID=0;seq=${sequence};rtptime=0` });
          if (!silent) { frame(); interval = setInterval(frame, 100); }
        } else { reply(headers.cseq, { Session: 'fixture-session' }); if (method === 'TEARDOWN') clearInterval(interval); }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `rtsp://127.0.0.1:${server.address().port}/test-only`;
  return { url, get connections() { return connections; }, get sent() { return sent; }, get openSockets() { return sockets.size; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
