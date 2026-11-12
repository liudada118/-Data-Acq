export function exportFormats() {
  return [
    { id: 'csv', label: 'CSV', available: true, description: '数值 CSV + WAV 音频 + RGB 帧 PNG / 原始 MJPEG 帧 JPG；附逐帧时间索引与原视频' },
    { id: 'npz', label: 'NumPy NPZ', available: true, description: '原始数值数组与纳秒索引；附麦克风 WAV、WebM / MP4 原视频和元数据' },
    { id: 'wav', label: 'WAV + 媒体', available: true, description: '真实麦克风 PCM16 WAV；原始音频转 float32 WAV，附数值与原视频' },
    { id: 'json', label: 'JSON + 原始数据', available: true, description: '元数据、原始二进制、麦克风 WAV、WebM / MP4 原视频和独立 Node.js 读取模块' },
    ...[['parquet', 'Parquet'], ['hdf5', 'HDF5'], ['mat', 'MATLAB MAT'], ['mp4', 'MP4']].map(([id, label]) => ({
      id, label, available: false, description: 'Node 原型暂未实现此格式，可先使用 CSV / NPZ / 原始数据',
    })),
  ];
}
