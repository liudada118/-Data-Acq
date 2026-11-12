/** Verified from the vendor documents named in docs/hx-d350-integration.md. */
export const HX_D350_MANIFEST = {
  api_version: 1,
  id: 'hx-d350-rtsp',
  name: 'HX-D350 双目相机（RTSP）',
  version: '1.0.0',
  entry: 'adapter.mjs',
  description: '双路 RTSP 原始 RGB 接入。厂商资料的左右目端口定义不一致，按端口命名，需实机遮挡镜头确认；不含实时 IMU。当前使用 RGB 原始录制，双路 30 fps 约 345.6 MB/s，长时间录制前请评估磁盘。',
  streams: [1254, 1256].map(port => ({
    id: `channel-${port}`,
    name: `通道 ${port}（左右待确认）`,
    kind: 'camera',
    dtype: 'uint8',
    shape: [1200, 1600, 3],
    sample_rate: 0,
    unit: 'RGB8',
  })),
  config_fields: [{ key: 'camera_ip', label: '相机 IP 或主机名（连接时必填）', type: 'string', required: false, default: '' }],
};

// Kept as source text so it goes through the same draft, test and install lifecycle
// as an Agent-authored adapter; importing this recipe never connects a camera.
export const HX_D350_ADAPTER = String.raw`import { isIP } from 'node:net';

function cameraHost(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写相机 IP 或主机名，可在 UDEGO 设备信息中查看。');
  const host = value.trim();
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(unwrapped) === 6) return '[' + unwrapped + ']';
  if (isIP(host) === 4) return host;
  if (host.length > 253 || /^[\d.]+$/.test(host) || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    throw new Error('请输入有效 IP 或主机名，不要包含 rtsp://、端口、路径或登录凭据。');
  }
  return host;
}

export function createAdapter({ config = {}, media }) {
  if (!media || typeof media.probe !== 'function' || typeof media.createRtspSource !== 'function') {
    throw new Error('当前软件缺少内置 RTSP 媒体桥接，请更新数采软件后重新测试。');
  }
  let sources = [];
  let starting;

  async function stopSources(items) {
    const results = await Promise.allSettled(items.map(source => Promise.resolve().then(() => source.stop())));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  return {
    async probe() {
      const result = await media.probe();
      if (result === false || result?.ok === false || result?.passed === false) {
        throw new Error('内置 RTSP 媒体桥接自检失败。');
      }
      return { ok: true, hardware_verified: false, message: '媒体桥接可用；未连接相机，左右目与实际流参数待实机确认。' };
    },
    async start() {
      if (starting) return starting;
      if (sources.length) return;
      const host = cameraHost(config.camera_ip);
      const created = [];
      sources = created;
      starting = (async () => {
        try {
          for (const port of [1254, 1256]) {
            created.push(media.createRtspSource({ stream_id: 'channel-' + port, url: 'rtsp://' + host + ':' + port, transport: 'tcp' }));
          }
          // start() resolves only after a real frame from each channel. The host
          // verifies dimensions, emits RGB8 and records its own receive time.
          await Promise.all(created.map(source => source.start()));
        } catch (error) {
          await stopSources(created).catch(() => {});
          if (sources === created) sources = [];
          throw error;
        }
      })().finally(() => { starting = undefined; });
      return starting;
    },
    async stop() {
      const previous = sources;
      sources = [];
      await stopSources(previous);
    },
  };
}
`;
