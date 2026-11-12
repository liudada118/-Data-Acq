# SDK 采集插件 v1

本接口用于把厂商 SDK 适配到数采的传感器目录、实时预览和统一录制。SDK 原件放在插件的 `sdk/` 子目录，Agent 生成 `plugin.json` 与 `adapter.mjs`。安装仅注册设备类型；用户在采集卡片点击连接后才调用 `start()`。

## 包结构与清单

```text
plugins/<plugin-id>/
  plugin.json
  adapter.mjs
  sdk/                 # 导入的厂商 SDK、文档和已有运行依赖
```

```json
{
  "api_version": 1,
  "id": "vendor-camera",
  "name": "厂商相机",
  "version": "1.0.0",
  "entry": "adapter.mjs",
  "config_fields": [
    { "key": "address", "label": "设备地址", "type": "string", "required": true }
  ],
  "streams": [
    { "id": "rgb", "name": "彩色图像", "kind": "camera", "dtype": "uint8", "shape": [480, 640, 3], "sample_rate": 30, "unit": "RGB8" }
  ]
}
```

插件 ID、数据流 ID 和配置字段 key 为小写字母开头的 1–32 个字母、数字、下划线或短横线。版本使用 `major.minor.patch`，可附预发布后缀。每包 1–8 路数据流、最多 24 个配置字段。配置类型支持 `string`、`number`、`boolean`；可声明 `required` 和 `default`。不支持的字段不会透传为任意表单或脚本。

| kind | dtype | shape / 数据格式 |
| --- | --- | --- |
| camera | uint8 | `[高, 宽, 3]` 为解码后尺寸；默认 RGB8，也可声明 `encoding:"mjpeg"` 原样保存一帧可变长 JPEG |
| pressure | uint8 / uint16 / float32 | `[行, 列]`，最多 65,536 个通道 |
| imu | uint8 / uint16 / float32 | 推荐 `[通道数]`，最多 256 个通道；原始字节与物理量要正确标明单位 |
| audio | float32 | `[通道数]`，1–8 通道、交织 PCM；采样率 8,000–384,000 Hz |

多字节数值使用小端序。未知采样率填 `0`（audio 除外），不能用猜测值代替真实 SDK 参数。未知物理单位填空或确切的原始单位，例如 `ADC`。清单在一次连接中固定，配置若改变分辨率或通道数量，应使用匹配的清单版本。

## 适配器生命周期

```js
export async function createAdapter({ config, emit, error, media, native }) {
  // 这里只构建实例；不要连接设备、订阅数据或启动线程。
  return {
    async probe() {
      // 可选：检查 SDK 模块/依赖/版本；不能打开实机或启动数据流。
      // 缺少驱动或绑定时抛出明确错误。
      return { ok: true, message: '依赖已加载，设备尚未验证' };
    },
    async start() {
      // 连接真实设备并注册 SDK 回调，在回调中调用 emit。
      // 断开或运行错误通过 error(new Error('...')) 报告。
    },
    async stop() {
      // 停止设备、取消回调、释放 SDK/句柄；允许重复调用。
    },
  };
}
```

真实回调通过以下结构送入宿主：

```js
emit({
  stream_id: 'rgb',
  payload: rgbBytes,          // Buffer 或 Uint8Array
  sample_count: 1,           // 默认 1；camera 必须 1
  sequence: sourceSequence,  // 可选：SDK 真实原始序号
  device_time_ns: sourceNs,  // 可选：SDK 真实设备时间，bigint 或十进制字符串
});
```

默认 `payload.byteLength` 必须等于 `sample_count × shape 各维乘积 × dtype 字节数`。相机显式 `encoding:"mjpeg"` 时每条记录必须 `sample_count:1`，payload 是一帧实际 JPEG 的原始字节，长度 1 字节至 32 MiB；shape 描述解码尺寸，不是压缩负载长度。使用 `native.copy` 在原生帧释放前取得自有内存，宿主 emit 内立即序列化 IPC；不会延迟借用 SDK 指针。RGB 的通道排列、stride、Bayer 解码、BGR→RGB 转换由适配器按 SDK 文档完成，不能只改清单标签。MJPEG 不裁切 padding，不二次压缩，不跳过坏帧冒充连续。

不要生成随机或示例数据来替代真实设备。`emit` 返回 `false` 表示宿主拒绝数据；运行失败后应终止 SDK 回调。

## 文档与模型生成

桌面来源导入最多 10,000 个文件、总计 8 GiB、单文件 2 GiB；完整包另外为两份各最多 256 KiB 的草稿预留 2 个文件和 512 KiB。工作区状态文件上限 16 MiB。页面上传仍最多 32 MiB，模型读取普通文本最多 1 MiB、单份 DOCX/PDF 最多 16 MiB；默认每次 24,000、最多 48,000 个 UTF-16 字符，按 `next_offset` 继续读取。导入二进制与发送模型文本是不同容量边界。

文件夹先经过元信息预检再流式计算、复制并核对 SHA256，超限提示目录、已发现数量/大小、上限与触发文件。厂商二进制完整保留，仅跳过既有凭据/密钥/环境文件规则；不通过静默筛掉大型库或示例来绕过限制。复制检测链接、路径越界和来源变化，可在正常关闭时取消。目标磁盘需覆盖新增副本并额外保留 512 MiB；暂存 `.import-*` 完成后原子发布，失败清理本次副本。桌面目录选择与导入全过程互斥，等待真实完成，不套固定 180 秒 RPC 超时。

内置 Agent 可通过 `read_sdk_file` 读取导入的代码文本、DOCX 正文及 PDF 文字层，后两者在本地 worker 解析。PDF 返回页码；图片页没有 OCR，不能假设图示已经读到。既有工作区内文档也可读取，不依赖旧元数据的 `text` 标志；仍需通过路径和导入时 SHA256 校验。

`read_runtime_capabilities` 返回软件提供的通用文档、媒体、原生 C ABI 接口及限制，不返回任何厂商适配器源码。模型需自行核对导入资料、写出 `plugin.json` 和 `adapter.mjs`。有冲突的通道定义应保留待确认状态，未知 API、帧率或硬件时间戳不可补猜。Agent 无任意 shell、依赖安装、自动测试或安装工具；草稿生成与用户显式测试、安装分开。

`replace_draft_text({path,before,after})` 支持局部修订，仅允许 `plugin.json`、`adapter.mjs`。应先用 `read_draft_file` 取得当前内容；`before` 必须非空且在原文中精确出现一次，零匹配或多匹配都拒绝且不修改文件。`before`、`after` 和替换后的完整草稿分别受 256 KiB 限制；清单仍需通过 JSON/入口检查。通过校验后以临时文件原子替换目标，更新草稿修订并废弃旧测试，不执行或安装代码。工具减少小修复的全文重写量及模型输出等待，不绕过验证门禁。

每次对话最多 32 轮模型/工具交互，累计上下文最多 1 MiB、整轮最多 20 分钟；单次模型请求默认 10 分钟并包含响应正文读取，任务仍可主动取消。整轮超时记为 `failed`，明确提示“适配任务超过 20 分钟”；主动取消记为 `cancelled`，不混淆两者。达到限制后保留已经写入的草稿，可继续对话局部修订；单文件读取容量不代表整轮可无限加入文档。

成功的 `write_draft_file` 或 `replace_draft_text` 对话工具写入会记录 `generation.source:'agent'`、`task_id`、`model`、`revision` 与 `updated_at`；对话外的草稿写入记为 `source:'manual'`。只有来源修订与当前草稿修订一致时，界面才显示“内置 Agent 生成 · 模型名称”，否则提示对话工具外修改。安装来源文件 `.installation.json` 保存这份记录，便于区分实际模型生成与手动草稿；来源标记不是代码安全或硬件验收结论。

## 内置 RTSP 媒体能力

宿主在 factory 中额外注入 `media`，现有只用 `config/emit/error` 的适配器保持兼容：

| 接口 | 行为 |
| --- | --- |
| `await media.probe()` | 检查应用自带 FFmpeg 可执行文件及版本，返回 `ok`、`hardware_verified:false`；不连接网络或打开相机。 |
| `media.createRtspSource({stream_id,url,transport})` | 为清单中已有的 camera 流创建受管源；仅接受 `rtsp://`，传输为 `tcp`（默认）或 `udp`；创建时不连接。同一宿主内每个 `stream_id` 只能创建一次。 |
| `await source.start()` | 启动取流并等待首个完整真实图像；依赖探测期间禁止调用。 |
| `await source.stop()` | 幂等停止媒体子进程，等待释放。适配器必须停止所有已创建源，包括另一通道启动失败时。 |

媒体宿主自动向指定流发送 RGB8，适配器不要再次 `emit` 同一图像。每帧实际宽高与清单的 `[height,width,3]` 必须匹配；不匹配立即报错，不隐式缩放、限帧或补帧。10 秒无完整图像、解码进程异常或宿主拒收均报错并清理。随包解码器由软件指定，模型不能替换可执行文件或传入任意命令参数；宿主关闭时也会清理受管源。

整体插件连接限时 15 秒，多路视频应并发等待首帧，失败时停止全部已创建源。`stop()` 幂等不表示源可重新启动：停止后的媒体源不能复用，也不能在原宿主用相同 `stream_id` 再创建一份；用户重新连接时，软件创建新的适配器与媒体宿主。

当前桥接只处理视频，不提取 SEI 曝光时钟，不返回实时音频/IMU，不保存原始压缩流。RTSP 网络到达时间不能当作设备曝光时间或双目同步证据。双路 1600×1200 RGB8@30fps 约 345.6 MB/s、1.24 TB/小时，长时采集仍需后续压缩保存及吞吐验收。

## 内置原生 C ABI 能力

宿主通过 `createAdapter({config,emit,error,media,native})` 注入 `native`，使用随包 Koffi 3.3.7，在独立插件子进程调用已有共享库。该能力面向厂商公开的 C ABI；不要求厂商已有 `.node`，但不会自动推断头文件、编译 C++ 类或安装驱动。

| 接口 | 约定 |
| --- | --- |
| `await native.load('bin/vendor.dll')` | 路径相对于当前插件的 `sdk/`。仅加载存在的普通 `.dll`、`.so` 或 `.dylib`，拒绝绝对路径、越界和链接；Windows x64 已提供支持，仍需库的架构与依赖匹配。 |
| `lib.func(declaration)` / `lib.func(name, returnType, paramTypes)` | 根据真实 C 头文件绑定导出函数。返回值、参数、结构体布局和调用约定必须与 SDK 一致；函数名示例不是供应商 API。 |
| `fn.async(...args, callback)` | Koffi 工作线程异步调用，回调为 `(err,result)`，可用 `util.promisify`。阻塞取帧、启动及停止应使用此方式，不能在宿主 JS 线程里同步等待循环。 |
| `native.ffi` | 提供 `struct/pack/union/array/opaque/pointer/out/inout/proto/register/unregister/as/decode/encode/sizeof/alignof/alias/type/enumeration`。原生指针用 bigint；空指针为 null 或 0n。 |
| `native.copy(pointer, byteLength)` | 将 SDK 仍有效的原生内存复制为独立 Buffer，长度 1 字节至 32 MiB。必须在释放原生帧前调用，只能使用 SDK 返回的有效非空指针；宿主无法证明任意地址有效。 |
| `native.version/platform/arch` | 当前 FFI 版本、宿主平台与架构，用于依赖自检。 |

Windows 依赖由 Koffi/系统加载器解析：先尝试常规 `LoadLibraryW`，失败后再尝试包含被加载 DLL 所在目录的搜索。应保留厂商 DLL 与依赖的目录关系，但不能承诺所有依赖始终优先来自包内，也不隔离系统已经加载的同名库；宿主不修改全局 PATH。

`probe()` 可以加载共享库、绑定必要导出并读取版本；不枚举/打开设备、不启动数据流。`start()` 才选择真实设备和受支持的 profile，检查像素格式/尺寸并等待首帧；无设备或不支持请求模式应明确报错，不能生成假帧或默默改变尺寸。工厂及库加载仍可能执行原生初始化代码，独立进程用于故障隔离，**不是操作系统权限沙箱**。

以不透明 `void*` 表示句柄；`void**` 错误输出需要正确标注 `_Out_`，每次调用创建新的输出容器，检查结果，并使用 SDK 自己的错误消息与删除接口释放错误对象。异步调用完成前保持输出参数及句柄有效；不能让取帧与删除同一 pipeline 并行。优先短超时异步轮询，建议每次等待约 100 ms；必须使用回调的 SDK 要持有注册引用，在 SDK 完全停止回调后才注销，避免同步停止等待 JS 回调造成死锁。

原生插件同样需在整体 15 秒连接期限内完成 `start()`；`stop()` 清理预算 10 秒，父进程在 11 秒后兜底终止宿主。应先标记停止，等待短超时的在途取帧结束，再执行 stop/delete；不能选择超过清理预算的阻塞等待。连接完成后，宿主对清单 `sample_rate >= 1` 的 camera 流逐路监测，连续 10 秒无有效帧会报错并停止插件，避免 SDK 一直返回 null 却显示在线。未知采样率、低于 1 Hz 或触发式流不套用此固定阈值，应按设备真实语义判断存活；此项监测不代表帧率或丢帧验收。

`stop()` 必须幂等：设置停止标志，等在途短超时取帧完成后再停止/删除，按 SDK 所有权释放每个 frame、frameset、profile、config、pipeline、context 和 error；启动失败也要清理。共享库保留至插件进程退出，不提供手动 unload，避免尚在运行的 SDK 线程/FFI 调用访问已卸载代码；宿主不会代替适配器释放每个 SDK 对象。

设备时间戳与序号依 SDK 头文件标注读取。64 位值先转 BigInt，再按真实单位转换，例如微秒乘 `1000n` 得纳秒；不能添加主机偏移伪装成设备时钟，也不能因两台设备都有时间戳便声称同步。

## 原生 SDK 与相机边界

- 可以加载已随 SDK 提供的 JavaScript / Node 模块；包内依赖使用相对路径或 `import.meta.url` 定位。
- DLL 不能当 JavaScript 模块导入，但有明确 C ABI 的共享库可用上述 `native` 能力。纯 C++ 类、模板、名字修饰/对象 ABI 和静态 `.lib` 不在此范围，仍需 C 包装层、专用 `.node` 或已有桥接程序。Agent 当前没有任意 shell、依赖安装或编译工具。
- `.node` 文件必须匹配 Windows 架构与实际宿主 Node/Electron ABI；开发用 Node 与打包 Electron 的 ABI 可能不同。Node-API 模块也需要匹配其最低 API 版本和原生依赖。
- SDK 自带桥接进程由适配器创建时，必须由 `stop()` 终止并等待退出；宿主只能直接管理自己的插件进程，不能代替 SDK 清理任意外部服务。
- RTSP 相机可使用上述软件自带媒体桥接，不要求厂商额外提供 JS 解码库。UVC 设备也可先使用已有系统摄像头入口；系统摄像头卡片与 SDK 插件是不同采集路径。
- 相机 v1 可录制完整 RGB 或原始 MJPEG，格式均为 MDAQBIN，不是 H.264/H.265/MP4；每条头中的 payload_bytes 给出实际长度。RTSP 桥接仍输出 RGB，不自动保留 RTSP 压缩流。RGB 预览缩小到不超过 160×120，沿用低频 JSON；MJPEG 实时预览使用独立按需二进制流，目标最高 30 Hz、每帧最多 2 MiB，普通 JSON 快照只保留质量与元信息，不包含整帧 base64。隐藏、暂停与卸载取消预览订阅，采集及原始录制继续。图像解码只保留一个在途任务及最新待处理帧；预览失败显示错误并计数，原始录制继续保留该帧。回放仍兼容 base64 JPEG 快照。
- 1080p RGB8、30 fps 约产生 187 MB/s 原始数据。此 Node 原型有复制和 IPC 开销，不能据此承诺工业多相机吞吐量；需要原生编码/零拷贝传输时，应扩展下一版运行时。
- 原生 SDK 的 MJPG 可通过 `encoding:"mjpeg",unit:"MJPEG"` 直接透传，避免采集进程逐帧解码和 RGB 跨进程传输；YUYV 等其他格式仍需转换 RGB8。当前 camera 不支持原始 Depth/IR uint16，不得将深度/红外数值冒充 RGB 或压力。Koffi 调用成功不等于像素格式、实机帧率或硬件同步已验收。
- audio 插件记录原始 float32 数据流；现有系统麦克风卡片的分段 PCM16 WAV 通道保持原样。插件 v1 不自动把任意音频 SDK 转成 WAV。

## 时钟与数据完整性

每张卡片的流 ID 为 `plugin-<instance_id>-<stream_id>`。同一个插件可连接多个实例，最多 16 个同时连接。

二进制文件采用现有 `MDAQBIN1` 和 `<QqqII>` 记录头。`device_time_ns` 在这个文件格式里统一使用**主机收到插件帧时距采集进程启动的时间**，`host_time_ns` 是主机单调时钟；这不是硬件同步时间。适配器提供的真实 SDK 时间戳和序号另存到 `plugin-frames.jsonl` 的 `source_device_time_ns`、`source_sequence`，不会冒充主机时钟。

插件 IPC 最多 32 个未确认数据块、64 MiB；主采集写盘队列继续使用既有容量限制。发生溢出、数据尺寸错误或插件进程退出时，宿主明确报错，相关录制标为不完整，不把丢数据隐藏成正常采集。

MJPEG 结构异常不会丢弃原字节，`plugin-frames.jsonl` 保存逐帧 `jpeg_status`（仅 SOI/SOF/SOS/EOI/尺寸检查，`decoder_verified:false`）；异常或大于预览限制时禁止界面解码但保留记录。源序号缺口、重复、倒序、未提供序号分别统计，逆序后的不确定区间不推测丢帧。连接期统计在卡片显示；每次录制独立重置并将快照写入 `manifest.streams[].quality`，连续性报告标注它是录制期快照、非重新解码结果。应用序号连续不等于设备零丢帧，已完整写盘也不等于图像无损坏。

回放按变长记录头定位 MJPEG，不使用 RGB 固定步长。转换导出保持 `.jpg` 原字节和 `frames.csv` 时间戳/结构状态；坏 JPEG 也能导出，不伪装成解码成功的 PNG。默认 RGB 和旧录制兼容。

## 测试、安装与安全边界

草稿写入只重算两个小文件的哈希，复用已导入 SDK 的内容哈希；测试前后与安装前仍校验整个包，旧测试不能用于已变化的依赖或代码。安装前也检查新增副本空间和 512 MiB 余量，先复制校验 staging，再替换活动版本；复制失败清理本次 stage，旧版仍保留。源 SDK、已完成工作区及旧插件不会作为失败清理对象。

静态检查只验证路径和清单，不导入代码。点击测试后，在独立进程执行模块导入、`createAdapter()`、可选 `probe()` 和 `stop()`，不调用 `start()`；15 秒宿主默认超时（Agent 工作流配置为 10 秒）。测试通过只代表接口/依赖自检通过，`hardware_verified` 始终为 `false`。连接后收到数据会单独标记 `data_received`，不自动宣称硬件准确性已验收。

独立进程用于隔离崩溃，**不是权限沙箱**。已导入的 SDK、适配器及其原生库都以当前用户身份运行，仅测试和安装可信来源。插件子进程不继承应用模型密钥和 SDK 授权环境变量；确需许可证的 SDK 应使用明确的连接配置或厂商授权机制，不把密钥写入适配器或对话。

以下回归全部使用临时目录中的测试夹具，不注册生产模拟传感器、不连接真实设备、不运行导出：

```powershell
cd C:\code\数采\node
node --test test/plugin-runtime.test.mjs
node --test test/capture.test.mjs
```

覆盖静态路径验证、测试不启动采集、环境密钥隔离、相机/压力数据录制及原始时间戳保存、插件崩溃、畸形负载、IPC 溢出和测试超时。
