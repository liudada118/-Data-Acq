/** Isolated Web Audio doubles. No browser permissions, microphone or network are accessed. */
export class FakeAudioTrack extends EventTarget {
  readyState = "live";
  label = "DroidCam Audio fixture";
  stops = 0;
  settings: MediaTrackSettings = { deviceId: "fixture-microphone", channelCount: 1, sampleRate: 44100 };
  getSettings() { return this.settings; }
  stop() { this.stops++; this.readyState = "ended"; }
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
export class FakeAudioStream {
  track = new FakeAudioTrack();
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
  getVideoTracks() { return []; }
}
export class FakeAudioNode extends EventTarget {
  connections = new Set<unknown>();
  disconnects = 0;
  connect<T>(node: T): T { this.connections.add(node); return node; }
  disconnect(node?: unknown) { this.disconnects++; if (node) this.connections.delete(node); else this.connections.clear(); }
}
export class FakeAnalyser extends FakeAudioNode {
  fftSize = 2048;
  get frequencyBinCount() { return this.fftSize / 2; }
  getFloatTimeDomainData(array: Float32Array) { array.fill(0); }
  getByteTimeDomainData(array: Uint8Array) { array.fill(128); }
}
class FakeGain extends FakeAudioNode { gain = { value: 1 }; }
export class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48000;
  state = "running";
  closes = 0;
  resumes = 0;
  modules: string[] = [];
  sources: FakeAudioNode[] = [];
  gains: FakeGain[] = [];
  analysers: FakeAnalyser[] = [];
  destination = new FakeAudioNode();
  audioWorklet = { addModule: async (url: string) => { this.modules.push(url); } };
  constructor(_options?: AudioContextOptions) { super(); FakeAudioContext.instances.push(this); }
  async resume() { this.resumes++; this.state = "running"; }
  async close() { this.closes++; this.changeState("closed"); }
  changeState(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
  createMediaStreamSource(_stream: MediaStream) { const node = new FakeAudioNode(); this.sources.push(node); return node; }
  createAnalyser() { const node = new FakeAnalyser(); this.analysers.push(node); return node; }
  createGain() { const node = new FakeGain(); this.gains.push(node); return node; }
}
interface Message { type: string; capture_id?: string; index?: number; buffer?: ArrayBuffer; error?: string }
export class FakeMicrophoneWorklet extends FakeAudioNode {
  static instances: FakeMicrophoneWorklet[] = [];
  captureId = "";
  index = 0;
  stops = 0;
  autoStart = true;
  autoStop = true;
  finalChunk = new Int16Array([123, -456]).buffer;
  messages: Message[] = [];
  port = {
    onmessage: null as ((event: MessageEvent<Message>) => void) | null,
    closed: false,
    postMessage: (message: Message) => {
      this.messages.push(message);
      if (message.type === "start") {
        this.captureId = message.capture_id!;
        if (this.autoStart) queueMicrotask(() => this.emit({ type: "started", capture_id: this.captureId }));
      } else if (message.type === "stop") {
        this.stops++;
        if (this.autoStop) queueMicrotask(() => this.finishStop());
      }
    },
    close: () => { this.port.closed = true; },
  };
  constructor(readonly context: FakeAudioContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    super(); FakeMicrophoneWorklet.instances.push(this);
  }
  emit(message: Message) { if (!this.port.closed) this.port.onmessage?.({ data: message } as MessageEvent<Message>); }
  emitChunk(buffer = new Int16Array([100, -100, 200]).buffer) {
    this.emit({ type: "chunk", capture_id: this.captureId, index: this.index++, buffer });
  }
  finishStop() {
    if (this.finalChunk.byteLength) this.emitChunk(this.finalChunk);
    this.emit({ type: "stopped", capture_id: this.captureId });
  }
  fail(message = "fixture processor failure") { this.emit({ type: "error", capture_id: this.captureId, error: message }); }
  processorError() { this.dispatchEvent(new Event("processorerror")); }
}
export function installMicrophoneMediaFixture() {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const previousWorklet = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  FakeAudioContext.instances = []; FakeMicrophoneWorklet.instances = [];
  let capture: (() => Promise<FakeAudioStream>) | undefined;
  let devices = [
    { kind: "audioinput", deviceId: "fixture-microphone", label: "DroidCam Audio fixture" },
    { kind: "audiooutput", deviceId: "speaker", label: "Not an input" },
  ];
  const streams: FakeAudioStream[] = [], constraints: MediaStreamConstraints[] = [];
  let enumerations = 0;
  const mediaDevices = Object.assign(new EventTarget(), {
    async getUserMedia(input: MediaStreamConstraints) {
      constraints.push(input);
      const stream = capture ? await capture() : new FakeAudioStream();
      streams.push(stream); return stream;
    },
    async enumerateDevices() { enumerations++; return devices; },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices } });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, writable: true, value: FakeMicrophoneWorklet });
  return { streams, constraints, mediaDevices, contexts: FakeAudioContext.instances, nodes: FakeMicrophoneWorklet.instances,
    setCapture(value?: typeof capture) { capture = value; },
    setDevices(value: typeof devices) { devices = value; },
    enumerations: () => enumerations,
    restore() {
      for (const [name, descriptor] of [["navigator", previousNavigator], ["AudioContext", previousContext], ["AudioWorkletNode", previousWorklet]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
