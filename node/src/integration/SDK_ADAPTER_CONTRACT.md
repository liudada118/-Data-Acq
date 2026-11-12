# SDK 接入 Agent 与插件接口 v1

工作链路：桌面导入 SDK 文件夹 → 对话读取 SDK 文档与示例 → 生成 `plugin.json` 和 `adapter.mjs` 草稿 → 用户点击测试 → 测试通过后安装 → 传感器列表添加卡片 → 用户连接 → 统一开始/停止录制。

## 导入与模型边界

- 原 SDK 复制到工作区 `draft/sdk/`，保留 DLL、Node 扩展与其他二进制，但不把二进制发给模型。
- 桌面 SDK 来源上限为 10,000 个文件、总计 8 GiB、单文件 2 GiB；工作区状态文件上限 16 MiB。完整插件包在此基础为 `plugin.json`、`adapter.mjs` 预留 2 个文件及 512 KiB，每份草稿仍最多 256 KiB。符号链接和路径穿越被拒绝；只按既有 `secretPath` 规则跳过 `.git`、`.env*`、凭据及密钥文件，不因是固件、示例或二进制而静默排除。页面上传总量仍限 32 MiB。
- 只有用户发起对话后，模型才能按工具读取所导入文本、DOCX 正文或 PDF 文字层。普通文本上限 1 MiB，DOCX/PDF 单文件上限 16 MiB；文件受导入时的 SHA-256 校验保护，变化后需要重新导入。旧工作区内的 DOCX/PDF 也可直接读取。
- DOCX/PDF 在本地独立 worker 提取正文，不执行宏、图片、附件或链接；PDF 保留页码，无 OCR。PDF 最多 200 页，解析 15 秒超时，最多 1 Mi 字符，超限明确标记；`read_sdk_file` 默认返回 24000、最多 48000 个 UTF-16 字符，按 `next_offset` 分页。原二进制不会上传模型。
- Agent 使用 Responses 兼容接口；服务地址、模型及 API 密钥由 Electron 主进程管理。密钥只通过私有进程通信传递，不写入工作区、对话或草稿。
- 每次对话最多 32 轮模型/工具交互，累计上下文上限 1 MiB。单次模型请求默认最多 10 分钟，覆盖连接、响应头和响应正文读取，整轮对话限制 20 分钟，仍可主动取消。整轮超时为 `failed` 并提示“适配任务超过 20 分钟”，主动取消为 `cancelled`；请求超时、正文读取中断和非法 JSON 分别报告。超时或取消后保留已写草稿，不再执行迟到响应中的工具。
- 工具包括列文件、读 SDK 文本/文档、`read_runtime_capabilities` 查询通用接口、读/写两个草稿文件、`replace_draft_text` 局部替换和读取测试报告。能力工具不返回厂商适配器源码，适配器必须由模型根据实际 SDK 资料生成。模型没有任意终端、自动测试、安装或硬件连接工具。
- 修复草稿优先先 `read_draft_file`，再 `replace_draft_text({path,before,after})`。只允许两个草稿；`before` 必须非空且与原文唯一精确匹配，否则不改文件。替换参数及结果各限 256 KiB，结果仍执行清单检查；临时文件原子替换成功后更新修订、废弃旧测试。局部修复可减少全文输出，但不代表已经测试或安装。
- 源码和文档是待分析资料。不能将文档内的指令当成高优先级 Agent 指令。

导入先扫描元信息，确认文件数、总量和单文件限额后才计算哈希。超限报告选定目录、已发现值、上限及触发文件；文件复制使用流式哈希校验并检查来源变化、链接和路径。导入互斥，原生目录选择与复制完成受同一门闩保护；`importDirectory` 等待实际结果，不使用普通 RPC 的 180 秒超时。目标盘必须覆盖新增副本与元信息并保留 512 MiB 空间。`.import-*` 中的副本和状态完成后才原子发布为工作区；失败或正常关闭取消时清理本次暂存目录，不修改原 SDK。

## 插件包

```text
plugins/<plugin-id>/
  plugin.json
  adapter.mjs
  sdk/               # 导入的 SDK 原件及其已有运行时依赖
  .installation.json # 安装来源、草稿哈希、时间、未实机验证标志
```

最小清单示例：

```json
{
  "api_version": 1,
  "id": "vendor-camera",
  "name": "厂商摄像头",
  "version": "1.0.0",
  "entry": "adapter.mjs",
  "config_fields": [
    { "key": "serial", "label": "设备序列号", "type": "string", "required": false }
  ],
  "streams": [
    { "id": "rgb", "name": "RGB 图像", "kind": "camera", "dtype": "uint8", "shape": [480, 640, 3], "sample_rate": 30, "unit": "RGB8" }
  ]
}
```

`config_fields` 支持 string、number、boolean，可提供 `default`。`streams` 为 1–8 路。

| kind | dtype / shape | 说明 |
| --- | --- | --- |
| camera | uint8 / `[height,width,3]` | 默认逐行 RGB8；`encoding:"mjpeg"` 表示一条记录一帧原始可变长 JPEG，shape 只表示解码后尺寸。 |
| pressure | float32、uint16 或 uint8 / `[rows,cols]` | 数值为小端序；原始 ADC 不得标成经过标定的压力。 |
| imu | float32、uint16 或 uint8 / `[channels]` | 通道解释和单位应遵循厂商协议。 |
| audio | float32 / `[channels]` | 已知采样率，最多 8 通道，多个样本使用 sample_count。 |

## 适配器生命周期

```js
import { VendorDevice } from './sdk/index.mjs';

export function createAdapter({ config, emit, error, media, native }) {
  let device;
  return {
    async probe() {
      // 仅检查 SDK 可加载和必要的依赖/版本，不启动设备。
      return { ok: true, message: 'SDK 已加载，设备尚未验证' };
    },
    async start() {
      // 此处 VendorDevice 仅为接口说明，必须根据实际 SDK 文档替换。
      device = new VendorDevice(config);
      await device.open();
      device.onFrame(frame => emit({
        stream_id: 'rgb',
        payload: Buffer.from(frame.rgb), // 复制 SDK 会复用的缓冲区
        sample_count: 1,
        // 只有设备/SDK 真正提供时才填 sequence 和 device_time_ns。
      }));
      device.onError(error);
    },
    async stop() {
      // 幂等停止，撤销订阅，释放设备/native 资源。
      await device?.close();
      device = null;
    },
  };
}
```

`createAdapter` 必须无连接和采集副作用。隔离测试会加载 JS 模块、调用 factory 和可选 `probe()`、最后 `stop()`，不会调用 `start()`。模块顶层代码仍会执行：独立子进程隔离故障，**不是操作系统权限沙箱**，只测试可信 SDK 与已检查的适配代码。

探测成功只说明接口/自检通过，`hardware_verified` 始终为 false；没有 `probe` 的包会明确报告“厂商依赖尚未验证”。安装不是实机验收。有明确 C ABI 及头文件的共享库可使用宿主内置 Koffi，无需厂商 Node 绑定；纯 C++ 类/模板或静态 `.lib` 仍需要 C 包装层、专用绑定或已有桥接。Agent 不会猜造导出签名，也不会自动运行编译器或安装第三方依赖。

## 宿主提供的原生 C ABI

先调用 `read_runtime_capabilities`，读取通用 `native` API；实际函数和模式必须来自用户导入的头文件与调用示例，不用供应商专用内置模板替代模型生成。

- `createAdapter({config,emit,error,native})` 中可 `await native.load('bin/vendor.dll')`，路径相对 `sdk/`；只接受包内普通共享库，拒绝绝对路径、链接和越界，保持配套 DLL 的目录关系与架构一致。底层是 Koffi 3.3.7，不能直接调用 C++ 类/模板或静态库。Windows 先常规 `LoadLibraryW`，失败后再尝试包含 DLL 目录的依赖搜索，不承诺总是优先包内或隔离已有同名库，不修改全局 PATH。
- `lib.func('真实C签名')` 或 `lib.func(name, returnType, paramTypes)` 绑定导出，类型/结构体布局/调用约定必须准确。`native.ffi` 提供结构体、指针、输出参数、编解码与回调辅助；SDK 错误输出用正确的 `_Out_ void **`，每次建立新输出容器，检查并用 SDK 删除函数释放。
- 阻塞调用使用 `fn.async(...args, callback)` 或 `util.promisify(fn.async)`；轮询取帧建议约 100 ms 短超时，等待调用结束后才关闭/删除同一对象。整体连接期限 15 秒，stop 清理限 10 秒（父管理器 11 秒兜底），不能使用超过清理预算的阻塞等待。回调必须按真实签名注册、持有引用，停止回调后才注销，不能在同步 stop 中等待需 JS 处理的回调。
- `native.copy(pointer, byteLength)` 复制仍有效的 SDK 帧为独立 Buffer，长度 1 字节至 32 MiB。指针必须是 SDK 返回的有效非空 bigint，不能随意计算地址；在删除原生帧前完成复制。该 API 不验证任意内存地址安全。
- factory 不连接设备；probe 只加载库/绑定符号/读版本，不枚举或打开设备。start 选择真实设备及受支持 profile，验证尺寸、格式并等首帧，无实物需明确报错。MJPG 可声明 `encoding:"mjpeg",unit:"MJPEG"`，按 SDK 实际数据长度 `native.copy` 后直接 emit，避免 FormatConverter 阻塞录制；不得裁切、重编码或跳过坏帧。YUYV/BGR 转为 RGB8；不能把 Depth/IR uint16 伪装成 RGB 或压力。
- 连接完成后，清单 `sample_rate >= 1` 的 camera 流逐路监测，连续 10 秒无有效帧会报错并停止插件；SDK 取帧一直返回 null 也不能继续假显示在线。未知、低于 1 Hz 或触发式流不套用该固定阈值，按设备真实语义处理；存活监测不等于采集帧率和丢帧验收。
- stop 幂等，等待在途调用后释放每个有所有权的帧、frameset、profile、config、pipeline、context 和错误对象；启动失败同样清理。库保留到插件进程退出，不提供手动 unload；不能依赖宿主代为释放所有 SDK 句柄。
- 真实帧序号/时间戳保留精度，uint64 先转 BigInt，再按文档单位做微秒到纳秒等换算，不添加主机偏移伪造设备时间。存在时间戳不表示不同设备已经同步。
- Koffi 与独立插件进程不是 OS 权限沙箱。FFI、原始帧复制和 IPC 都有成本，队列仍为 32 块/64 MiB，单帧最多 32 MiB；原始 RGB 写盘量不减少，不能据无硬件自检宣称达到 C++ 原生性能或长期采集性能。

## 宿主提供的 RTSP 接入

对于 SDK 文档已经提供 RTSP 的设备，Agent 先调用 `read_runtime_capabilities`，再根据真实文档自行生成接口适配。软件已自带受管 FFmpeg，不需要厂商额外提供 JS 解码库，不需要模型安装依赖或执行 shell。

- factory 可使用 `createAdapter({config,emit,error,media})`，`probe()` 调用 `await media.probe()`，仅检查随包解码器，不访问设备。缺少地址只能阻止 `start()`，不能妨碍依赖自检。
- `start()` 中通过 `media.createRtspSource({stream_id,url,transport:'tcp'})` 为清单中每条 camera 流创建源，再并发 `await` 各路 `source.start()` 等待首帧。`url` 仅 `rtsp://`，`transport` 支持 `tcp` 或 `udp`。创建源不立即连接；探测模式禁止启动源。整个插件连接限时 15 秒，不应逐路串行耗尽首帧等待预算。
- `stop()` 必须停止并等待所有 `source.stop()`，重复停止安全；部分通道启动失败时也必须清理已创建源。宿主退出会补充清理受管子进程。
- 每个 `stream_id` 在同一媒体宿主内只能创建一次；已停止源不能重新启动或重新创建。再次连接由软件新建适配器与媒体宿主，不要在旧实例里伪造可复用连接状态。
- 宿主自动输出 RGB8，不要重复 `emit`。逐帧验证实际尺寸与清单，错误时停止；10 秒无完整帧报错，不默默缩放、限帧或补帧。
- 当前媒体能力只支持视频，不提供实时 IMU、音频或 SEI 曝光时间戳，不能拿主机时间冒充曝光时间。资料里的左右通道定义有冲突时先用中性名称并提示实机确认。
- 录制仍为原始 RGB MDAQBIN1，未保留 RTSP 压缩流。1600×1200 双路 30fps 约 345.6 MB/s、1.24 TB/小时，需要向用户说明容量与长时采集限制。UVC 可以走已有系统摄像头入口，其录制路径不同。

## 时间、预览与录制

- SDK 用 `emit({stream_id,payload,sample_count?,sequence?,device_time_ns?})` 推送真实数据。
- 宿主检查流 ID、负载长度与数据类型；有界进程队列溢出会报错，不静默丢弃。
- 宿主记录单调主机接收时间，独立保留 `source_device_time_ns` 与 `source_sequence` 到 `plugin-frames.jsonl`；不宣称这些时钟已硬件同步。
- RGB 相机预览缩小并限频；MJPEG 预览限频并由界面解码，与原始录制分离。`MDAQBIN1` 同时支持固定 RGB 帧及 `encoding:mjpeg` 的可变长原始 JPEG（每条记录头中的 payload_bytes 为真实长度）。MJPEG 原字节与设备序号/时间戳保留，预览失败不丢弃已收到的原始数据。非 raw 导出将 MJPEG 帧原样写为 `.jpg` 并附时间戳索引，不重编码。
- 插件独立进程的断开或崩溃会标明录制不完整；统一录制的队列、时间连续性和回放继续使用现有主机链路。

## 测试、安装与恢复

测试记录绑定整个草稿目录（包括 SDK 文件）的 SHA-256 摘要。写入两个小草稿时只重算草稿哈希并复用导入 SDK 的哈希，避免每次编辑重读大包；测试前后、安装前仍执行整树哈希校验。修改代码或 SDK 后必须重新测试；测试期间变化也不能安装。测试中断会废弃旧的通过结果。

安装先检查目标盘空间（新增副本及元信息，另保留 512 MiB），复制并校验 staging 包，再原子切换目录；旧包保留到 `plugins/.history/<id>/`。复制失败清理本次 stage 并保留旧包，切换失败恢复旧包。安装、测试、模型草稿写入按工作区互斥，安装期间不能并发改草稿。运行中的采集/插件应由 Electron 入口检查并阻止替换，成功后刷新后端插件目录。

`generation` 记录草稿写入来源。对话 `write_draft_file` 或 `replace_draft_text` 成功后保存 `source:'agent'`、任务 ID、模型、草稿修订和时间；对话外 `writeDraft` 记为 `source:'manual'`。UI 仅在来源修订匹配当前草稿时显示内置 Agent 生成，安装时将来源写入 `.installation.json`。这份审计信息用于说明草稿的生成途径，不代替测试、代码审查或实机验收。

测试夹具只放在自动化测试的临时目录里，不出现在正常传感器列表。
