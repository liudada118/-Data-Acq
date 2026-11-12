import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { MAX_FRAME_BYTES } from './contract.mjs';

// The executable is supplied with the application, never chosen by an SDK/model.
export const MEDIA_EXECUTABLE = ffmpegPath?.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
export const MEDIA_CAPABILITIES = Object.freeze({ version: 1, rtsp: true, output: 'RGB8',
  source_timestamps: false, compressed_recording: false, hardware_verified: false });

export function validateRtspUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) throw new Error('请输入有效的 RTSP 地址。');
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 RTSP 地址。'); }
  if (url.protocol !== 'rtsp:' || !url.hostname || url.hash) throw new Error('媒体桥接仅接受 rtsp:// 摄像头地址。');
  return value;
}

export function buildRtspArgs({ url, transport = 'tcp', timeoutMs = 8000 }) {
  validateRtspUrl(url);
  if (!['tcp', 'udp'].includes(transport)) throw new Error('RTSP transport 必须为 tcp 或 udp。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('RTSP 超时必须为 100–10000 毫秒。');
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror',
    '-protocol_whitelist', 'rtsp,tcp,udp,rtp,crypto', '-rtsp_transport', transport,
    '-timeout', String(timeoutMs * 1000), '-i', url, '-map', '0:v:0', '-an', '-sn', '-dn',
    // PPM carries each frame's dimensions; raw bytes alone could silently misframe
    // a device that changes modes. No scale/fps filter or synthetic frame duplication.
    '-threads', '2', '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-c:v', 'ppm', '-f', 'image2pipe', 'pipe:1'];
}

/** One bounded RGB frame plus a short PPM header; accepts arbitrary pipe chunks. */
export class PpmFrames {
  constructor({ width, height, onFrame }) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('无效的媒体帧尺寸。');
    this.size = width * height * 3;
    if (!Number.isSafeInteger(this.size) || this.size < 3 || this.size > MAX_FRAME_BYTES) throw new Error('无效的媒体帧尺寸。');
    this.width = width; this.height = height; this.onFrame = onFrame;
    this.header = []; this.frame = null; this.offset = 0;
  }
  push(chunk) {
    let index = 0;
    while (index < chunk.length) {
      if (!this.frame) {
        this.header.push(chunk[index++]);
        if (this.header.length > 256) throw new Error('视频帧头损坏。');
        if (this.header.at(-1) !== 10) continue;
        const header = Buffer.from(this.header).toString('ascii');
        const match = /^P6\s+(\d+)\s+(\d+)\s+255\n$/.exec(header);
        if (!match) continue;
        if (Number(match[1]) !== this.width || Number(match[2]) !== this.height) {
          throw new Error(`相机实际输出 ${match[1]}×${match[2]}，与适配器声明的 ${this.width}×${this.height} 不一致，请按设备实际模式修改适配器。`);
        }
        this.frame = Buffer.allocUnsafe(this.size); this.offset = 0; this.header = [];
      }
      const bytes = Math.min(this.size - this.offset, chunk.length - index);
      chunk.copy(this.frame, this.offset, index, index + bytes); index += bytes; this.offset += bytes;
      if (this.offset === this.size) {
        const frame = this.frame; this.frame = null; this.offset = 0;
        if (this.onFrame(frame) === false) throw new Error('采集宿主拒绝视频帧，媒体输入已停止。');
      }
    }
  }
  get partial() { return this.frame !== null || this.header.length > 0; }
}

const runtimeEnv = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const launch = args => {
  if (!MEDIA_EXECUTABLE) throw new Error('当前平台没有随应用安装的视频解码器。');
  return spawn(MEDIA_EXECUTABLE, args, { shell: false, windowsHide: true, env: runtimeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
};
async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 500);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

export async function probeMedia() {
  const child = launch(['-hide_banner', '-version']);
  try {
    return await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('视频解码器自检超时。')); }, 4000);
      child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(0, 4096); });
      child.stderr.resume();
      child.once('error', () => { clearTimeout(timer); reject(new Error('应用内置视频解码器无法启动，请重新安装应用依赖。')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0 || !output.startsWith('ffmpeg version ')) reject(new Error('视频解码器自检失败。'));
        else resolve({ ok: true, ...MEDIA_CAPABILITIES, decoder: output.split(/\r?\n/)[0].slice(0, 160), message: 'RTSP 解码依赖就绪；未连接相机，未验证硬件。' });
      });
    });
  } finally { await terminate(child); }
}

/** Managed capability injected into the adapter. Probe mode cannot open a source. */
export function createManagedMedia({ manifest, emit, error, probeOnly = false, onChild = () => {} }) {
  const sources = new Map(); let closed = false;
  function createRtspSource({ stream_id, url, transport = 'tcp' } = {}) {
    if (closed) throw new Error('媒体宿主已关闭。');
    const stream = manifest.streams.find(item => item.id === stream_id && item.kind === 'camera');
    if (!stream || sources.has(stream_id)) throw new Error('媒体源必须对应唯一的相机数据流。');
    const args = buildRtspArgs({ url, transport });
    let child, opening, stopping, rejected = false, watchdog, firstFrame;
    function failure(reason) {
      if (stopping || rejected) return;
      rejected = true; clearTimeout(watchdog);
      firstFrame?.reject(reason);
      error(reason);
      void stop();
    }
    function watch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => failure(new Error('RTSP 10 秒没有收到完整图像，请检查设备地址、网络和相机模式。')), 10_000);
    }
    async function start() {
      if (probeOnly) throw new Error('依赖测试期间禁止连接 RTSP 相机。');
      if (closed || stopping) throw new Error('媒体源已停止，请重新创建连接。');
      if (opening) return opening;
      firstFrame = Promise.withResolvers(); opening = firstFrame.promise;
      // Register the rejection immediately; a synchronous spawn failure must not
      // turn into an unhandled rejection before the caller awaits start().
      opening.catch(() => {});
      try {
        child = launch(args);
        child.once('spawn', () => onChild({ pid: child.pid, started: true }));
        child.once('error', () => failure(new Error('RTSP 解码器无法启动，请检查应用依赖。')));
        const parser = new PpmFrames({ width: stream.shape[1], height: stream.shape[0], onFrame: payload => {
          if (stopping || rejected) return false;
          const accepted = emit({ stream_id, payload, sample_count: 1 });
          if (accepted !== false) { watch(); firstFrame.resolve(); }
          return accepted;
        } });
        child.stdout.on('data', chunk => { try { parser.push(chunk); } catch (reason) { failure(reason); } });
        // Never expose the decoder's raw stderr: it can echo credentials in URLs.
        child.stderr.resume();
        child.once('close', code => {
          clearTimeout(watchdog); onChild({ pid: child.pid, started: false });
          if (!stopping && !rejected) failure(new Error(`RTSP 视频连接已结束（${code ?? '已终止'}${parser.partial ? '，存在不完整帧' : ''}），请检查网络、端口与设备输出。`));
        });
        watch();
      } catch (reason) { failure(reason); }
      return opening;
    }
    function stop() {
      if (stopping) return stopping;
      clearTimeout(watchdog);
      firstFrame?.reject(new Error('媒体源已停止。'));
      stopping = terminate(child);
      return stopping;
    }
    const source = Object.freeze({ start, stop }); sources.set(stream_id, source); return source;
  }
  return { api: Object.freeze({ capabilities: MEDIA_CAPABILITIES, probe: probeMedia, createRtspSource }),
    async close() { closed = true; await Promise.all([...sources.values()].map(source => source.stop())); } };
}
