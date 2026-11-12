// Generic host API only. Reading this never imports vendor code, supplies a
// device-specific adapter, launches a decoder or connects to a network.
export function runtimeCapabilities() {
  return {
    documents: ['text', 'docx (正文)', 'pdf (文字层，含页码；无 OCR)'],
    native: {
      available: '内置 Koffi 3.3.7，独立插件子进程内调用已导入 SDK 的 C ABI；Windows x64 已支持。无需厂商 Node 绑定。',
      adapter_context: 'createAdapter({config,emit,error,native})',
      methods: {
        "await native.load('bin/vendor.dll')": '路径相对于插件 sdk/，只接受存在的普通共享库，拒绝绝对路径/穿越/链接。返回 {func}。依赖由Koffi/Windows解析：先常规加载，失败再尝试包含DLL所在目录的搜索；保持厂商依赖DLL同目录，不保证隔离系统已有的同名依赖。失败报告位数/依赖错误，不修改全局PATH。',
        "lib.func('int vendor_version(void)')": '按已读 C 头文件声明导出签名；支持 lib.func(name,returnType,paramTypes)。C++ 类/模板/静态.lib不能直接调用。函数返回值、结构体布局、调用约定必须与 SDK 相符。',
        'fn.async(...args, (err,result)=>{})': 'Koffi工作线程异步调用；阻塞取帧/启动/停止都应使用此方式或util.promisify(fn.async)。不要用同步阻塞循环占用宿主事件循环。必须保持输出参数在异步完成前有效，避免与 stop/delete 并行访问同一对象。',
        'native.ffi': 'Koffi类型工具：struct/pack/union/array/opaque/pointer/out/inout/proto/register/unregister/as/decode/encode/sizeof/alignof/alias/type/enumeration。原生指针为bigint，空为null或0n。用void*表示不透明句柄，错误输出void**需_Out_标记。',
        'native.copy(pointer, byteLength)': '将仍有效的原生帧内存复制成独立Buffer，长度1字节至32MiB；在释放原生帧之前调用。只能传SDK返回的有效非空指针，宿主不能验证任意内存地址。',
      },
      errors: "例如 const f=lib.func('void *vendor_open(_Out_ void **error)'); const out=[null]; const handle=f(out); 每次调用重新建立out，检查out[0]，使用SDK错误消息API读取并使用SDK专用delete_error释放。这是通用语法示例，vendor_open不是实际厂商函数，必须按所读头文件替换。",
      lifecycle: 'factory无连接副作用；probe加载库、绑定必要导出、读版本，不枚举/打开设备、不启动采集。start选择真实设备/已有profile并等待首帧后成功；无设备明确报错，不假造帧。不支持请求的尺寸/格式必须提示，不静默改尺寸。stop幂等：设置停止标志，等待短超时的在途取帧完成，再stop/delete，释放每个拥有引用的frame/frameset/profile/config/pipeline/context/error。异常启动也清理。库保留到独立进程退出，不提供手动unload避免悬挂SDK线程；不能依赖宿主自动释放每个SDK句柄。',
      callbacks: '优先短超时异步轮询取完整帧。若SDK只能回调，先读取真实回调签名，register并持有回调引用；确认SDK完全停止回调后才unregister。不要在native同步stop里等待需要JS事件循环的回调，避免死锁。',
      formats: 'camera 支持默认 RGB8，或在流清单声明 encoding:"mjpeg", unit:"MJPEG" 保存 SDK 原始 MJPG/JPEG 帧。两者 dtype 都是 uint8、shape 都为解码后的 [高,宽,3]；mjpeg 每次 emit 必须 sample_count:1，payload 是一张完整 JPEG 的原始可变长度字节（1字节至32MiB），绝不能按 RGB 长度校验或裁切/重新编码。使用 native.copy 复制 SDK 实际 data_size 字节后释放原生帧，无需 FormatConverter，不允许丢弃坏帧假装连续。宿主将独立报告 JPEG 结构问题/预览失败并保留原字节。实际 profile/帧格式/尺寸必须验证，不静默改变采集模式。YUYV/BGR 仍需转换到声明的 RGB8；Depth/IR uint16 不能伪装 RGB 或压力。',
      timestamps: '按SDK标注单位转换真实帧时间戳和序号；uint64先转BigInt再做微秒到纳秒乘1000，避免JS精度丢失。不要添加主机偏移去伪造设备时间；不同设备时钟不表示已同步。',
      liveness: '宿主对清单sample_rate>=1的相机流逐路监测：连接完成后连续10秒无有效帧会报错并停止插件，避免SDK轮询一直返回null而假显示在线。未知/低频/触发流不使用此固定阈值，应按设备真实语义处理。',
      limits: '连接整体15秒内需完成start；stop清理需在10秒内完成（父进程在11秒后兜底终止），否则宿主会被终止。取帧建议100ms短超时，停止时等在途等待退出后释放，不能选超过清理期限的阻塞调用。Koffi不是OS权限沙箱。当前插件队列32帧/64MiB，单帧32MiB，超限明确停止。默认 camera 仍录制RGB，encoding:mjpeg则原样保存压缩帧。FFI、帧复制和IPC有额外开销，不能仅凭probe宣称长期稳定或达到原生C++性能。',
    },
    media: {
      available: '内置受控 FFmpeg RTSP 桥接；安装完整性由用户点击测试时的 media.probe 验证',
      adapter_context: 'createAdapter({ config, emit, error, media })',
      methods: {
        'media.probe()': '检查内置解码器版本，不打开网络或摄像头；异步返回 ok 和 hardware_verified:false',
        'media.createRtspSource({stream_id,url,transport})': '为已声明的camera流创建源，不立即连接。URL仅rtsp://，transport为tcp（默认）或udp。返回start()/stop()；start等待首帧，stop幂等释放受管子进程。同一宿主内每个stream_id只能创建一次；停止后的源不可重启，重新连接会创建新的适配器与媒体宿主。',
      },
      frames: '宿主自动emit RGB8；实际尺寸必须等于清单shape，尺寸不同报错，不隐式缩放、限帧或复制帧。不要自己再次emit。',
      limits: '只视频，不包含音频/IMU，不提取相机SEI曝光时间；主机到达时间不等于曝光时间，也不代表双目同步。未收到完整图像10秒后报错，整个插件连接限时15秒，多路宜并发等待首帧，失败时释放全部已创建源。',
      recording: '当前插件v1录制原始RGB到MDAQBIN1，尚不保留压缩视频；1600x1200双路30fps约345.6MB/s。必须说明容量，不可承诺长时或全速采集性能。',
    },
  };
}

