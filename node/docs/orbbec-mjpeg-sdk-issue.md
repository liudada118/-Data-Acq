# EGO SDK 原始 MJPEG 拒收定位记录（2026-11-12）

这份记录用于向相机/SDK 提供方复现和说明问题，尚未发送给任何外部人员。

## 当前软件与现象

- Windows x64、Electron 45.2.3 / Node 24、Koffi 3.3.7、用户提供的 Orbbec EGO SDK 2.9.0。
- 左右彩色目请求 SDK 默认 MJPG profile，实测 JPEG 为 1600×1200、约 30fps/目。
- `orbbec-ego@1.1.0` 由软件内置 Agent 生成：`wait_for_frameset(100ms)`，取原始 MJPG 的 data/data_size，在 delete_frame 前复制原始字节并 emit。没有调用 FormatConverter，不二次压缩或删除坏帧。
- 用户确认直连电脑 USB 3.x 接口。SDK 的连接描述字符串不能单独证明实际总线协商速率，不能据此认定线材或接口故障。
- 实测应用写盘队列没有丢弃，但 SDK 日志仍出现 `This frame will be dropped because jpg format verification failure! @LeftColor / @RightColor`，应用看到源 `ob_frame_get_index` 序号缺口。该序号不自动等于硬件曝光帧计数。

## 公开代码中的相关修复

[官方提交 726dd13：Improve MJPEG frame boundary validation](https://github.com/orbbec/OrbbecSDK_v2/commit/726dd13d5629bc9c8081ba6b68e29933d106105c) 修改 `VideoSensor.cpp` 与 JPEG 边界检测。旧公开实现从尾部有限字节查找终止标记，对尾随数据较严格；新版向后查找 EOI 并处理尾部填充。

[v2.10.6 发行说明](https://github.com/orbbec/OrbbecSDK_v2/releases/tag/v2.10.6) 另外说明了 MJPEG 无效帧检测、尾部 padding 处理及 FFD9 附近少量多余/缺失字节的解码容错。

旧 EGO 二进制的日志与该检查路径一致，但拒收帧没有交给应用；**尚不能证明本次所有拒收都是尾随字节误判，也可能存在实际截断/损坏**。应由 SDK 侧保留校验前原帧进行区分，不能直接禁用全部校验或补帧掩盖损失。

## 升级兼容性验证

官方 `OrbbecSDK_v2.10.6_Win_x64` 包 SHA-256 为 `61888798641df8cd2eccfe9df2a36c2b5417c0725dc88d19134877522c283975`，已在独立目录验证，不覆盖用户 SDK。

新 DLL 读取版本成功，但只读设备枚举返回 **0 台**，因此不能直接替换当前 EGO 专用构建。原 SDK、固件及设备属性均未修改。

## 需要提供方确认

实机补充证据：2026-11-12 约 10 分钟取流的最后持久化统计点为 587.303 秒，左右各收到 17,608 帧，约 29.98 fps；源序号缺口左 11、右 6，已交付帧结构异常 0、重复和倒序 0。前 128.196 秒录制左右各 3,839 帧，应用写盘丢弃 0，完整回读通过。SDK 日志 10:54:43.115 开始停止、10:54:46.383 完成。统计和录制范围不同，不能混用计数；应用源序号缺口也不是精确硬件丢帧计数。摘要位于 `node/.runtime/orbbec-mjpeg-endurance/summary.json`。

1. 提供仍支持此 EGO 型号、包含上述 JPEG 边界与解码修复的 SDK 构建，或对应的 EGO 源码以便合并补丁。
2. 在 `VideoSensor` 验证前保留少量被拒帧，确认是缺少 EOI、真实内容截断还是合法 JPEG 后存在尾随字节。
3. 明确该型号 `ob_frame_get_index` 的来源、重置/绕回规则；如有硬件曝光序号，提供读取方式。
4. 可用 `ob_pipeline_get_status` 区分 SDK 数据错误与队列溢出，但它是读取后清除的累计状态位，不能当精确丢帧计数。当前应用没有臆造状态结构或改设备压缩质量。

软件已将应用序号、SDK 源序号和 JPEG 结构诊断分开保存。已交付的 JPEG 即使不能预览也保留；SDK 交付前丢弃的帧无法由上层 Node 恢复。更换回调模式也不会绕过 SDK 这层校验。
