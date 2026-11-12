# Synapse · 多模态采集工作站

React 界面，Qt WebEngine 桌面窗口，独立 C++20 采集/录制服务，以及独立 Python 导出服务。

新增独立的 **Node.js 原型**，用于先验证 SDK 与采集链路：进入 `node` 目录运行 `npm run setup`、`npm start`，默认访问 `http://127.0.0.1:8785`。本机带实验标签、时间轴回放与补标的版本使用 `npm run start:annotations`，访问 **http://127.0.0.1:8788/**。详见 [Node 开发说明](node/README.md)。下面仍是原生桌面版的使用说明。

当前版本提供摄像头、麦克风、16×16 压力阵列和六轴 IMU 的**明确模拟设备**。可以选择设备组合、保存组合、录制原始数据、查看录制记录并导出。真实设备需要其 SDK 或串口/网口协议后编写适配器，界面不会把模拟数据显示为真实硬件。

## 启动

本机完成构建后，双击 **`启动工作站.cmd`**，或运行：

```powershell
.\.venv\Scripts\python.exe desktop/launch.py
```

启动器自动启动 C++ 服务 `127.0.0.1:8765` 和导出服务 `127.0.0.1:8766`，然后在 Qt WebEngine 中打开构建后的 React。日志位于 `.runtime/`。关闭窗口时，正在录制的会话会先提示停止并保存；正在导出时需要等待完成。

首次在另一台机器上构建，需要 Python 3.11+、Node.js 22.12+、CMake 3.24+ 和带 C++ 工具的 Visual Studio 2022：

```powershell
python scripts/bootstrap.py
```

该命令把 Python 依赖安装到项目 `.venv`，安装前端依赖并构建 React 与 C++。不会安装系统级编译器。原生库头文件和许可证已固定在 `native/vendor/`。

## 使用流程

1. 在设备列表勾选需要的模拟设备，输入实验名称，可把组合保存为预设。
2. 点击开始录制。原始数据由 C++ 写盘，预览可以单独暂停。
3. 停止录制，等待缓冲排空、文件完成关闭。
4. 在录制记录或导出中心选择会话与格式，创建导出任务。
5. 任务完成后下载 ZIP。包内保留会话 manifest、格式说明和时间戳等必要信息。

设备组合保存在当前界面的 localStorage；Qt 桌面窗口使用 `data/ui/` 下的持久化浏览器存储，录制数据在 `data/sessions/`，导出包在 `data/exports/`。这些数据不提交到版本控制。

## 数据与导出

| 格式 | 内容 |
| --- | --- |
| CSV | 数值流的表格数据；媒体附 WAV/PNG 和帧时间索引 |
| Parquet | 类型化数值流表格；媒体及元数据随包保存 |
| HDF5 | 分块多维数组和原始记录时间索引 |
| NPZ | 命名 NumPy 数组、形状与时间索引 |
| MAT | MATLAB 数组和时间索引 |
| WAV | 保留原始 float32 音频精度的 IEEE float WAV |
| JSON 数据包 | 原始 manifest、二进制流和读取说明/脚本 |

摄像头模拟画面采用无损 PNG 序列并附帧时间索引。MP4 在本版显示为不可用，尚未配置视频编码器。NPZ/MAT 为内存型导出，单流工作集超过保护上限时会明确报错，较大数据优先选择 HDF5/Parquet。具体打包结构见导出包内的说明。

原始录制格式是版本化的 `mdaqbin-v1` 加 `manifest.json`，不是 MCAP。格式定义见 [native/README.md](native/README.md)。每个流保留序号、设备时钟、主机单调时钟、采样率、dtype、shape、单位和计数；导出不会自动把不同采样率强制重采样为同一频率。

## 开发

```powershell
# 构建原生采集服务
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel

# 前端构建 / 热更新开发
npm.cmd --prefix frontend run build
npm.cmd --prefix frontend run dev

# 已构建时，用浏览器代替 Qt 窗口预览
.\.venv\Scripts\python.exe desktop/launch.py --browser

# 用 Qt 窗口连接 Vite（Vite 需另行启动）
.\.venv\Scripts\python.exe desktop/launch.py --url http://127.0.0.1:5173
```

## 验证

```powershell
ctest --test-dir build -C Release --output-on-failure
.\.venv\Scripts\python.exe native/tests/http_test.py --exe build/native/Release/syndaq_engine.exe
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe scripts/smoke_test.py
npm.cmd --prefix frontend run build
```

集成测试使用临时目录与独立端口，验证真正的 C++ 录制、Python 读取、异步导出及 ZIP 下载。当前模拟数据规模的验证不代表真实摄像头或其他硬件的最大吞吐性能；真实设备接入后按目标组合压测。

## 设备扩展

设备接口位于 `native/include/adapter.hpp`，模拟实现位于 `native/src/adapter.cpp`。集成真实设备时需要补充连接生命周期、配置校验、SDK/协议处理、设备时间戳及错误恢复。详见 [设备接入说明](docs/DEVICE_ADAPTERS.md) 和 [架构文档](ARCHITECTURE.md)。
