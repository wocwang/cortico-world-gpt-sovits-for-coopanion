/**
 * 本机声卡播放：PCM16 单声道经 audify(RtAudio,Windows 上走 WASAPI)按到达顺序写进一条输出流。
 * 设备有两个以上输出声道时开双声道流，每个样本复制到左右两路;只开一个声道时 RtAudio 只送进左声道。
 * audify 的输出队列无界、`write()` 不阻塞，所以排队即顺序;`cut()` 关流丢弃队列里没播的部分。
 * 播完时刻按写入的帧数换算墙钟，只用来报「正在说」。
 */
import { createRequire } from 'node:module';
import type { Logger } from 'cortico/core/types.ts';

interface RtAudioLike {
  openStream(
    out: { deviceId: number; nChannels: number; firstChannel: number },
    input: null,
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: null,
    frameOutputCallback: null,
  ): void;
  closeStream(): void;
  start(): void;
  write(buf: Buffer): void;
  getDevices(): Array<{ id: number; name: string; outputChannels: number }>;
  getDefaultOutputDevice(): number;
  isStreamOpen(): boolean;
  outputVolume: number;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number; WINDOWS_DS: number };
}

/** 音频后端：`auto` 先 WASAPI、枚举不到或打不开再退 DirectSound（issue #4 的机器上 WASAPI 返回空表）。 */
export type AudioBackend = 'auto' | 'wasapi' | 'directsound';

const BACKEND_LABEL: Record<Exclude<AudioBackend, 'auto'>, string> = { wasapi: 'WASAPI', directsound: 'DirectSound' };

/**
 * 每次写入的帧长:40 ms。原来是 20 ms，合成稍慢或网络抖一下就会出现「写不进去 → 空一段 → 再续上」的断续，
 * 听起来像按标点卡顿；40 ms 的缓冲只多 40 ms 延迟，换来的连续性好很多。
 */
const FRAME_MS = 40;

/** 软限幅的拐点：绝对值超过它的样本按 tanh 压到满幅以内。 */
const KNEE = 24000;

/** 单声道 PCM16 复制成 `channels` 路交错。 */
export function upmix(mono: Buffer, channels: number): Buffer {
  if (channels === 1) return mono;
  const out = Buffer.alloc(mono.length * channels);
  for (let i = 0, o = 0; i + 1 < mono.length; i += 2) {
    for (let c = 0; c < channels; c++, o += 2) { out[o] = mono[i]!; out[o + 1] = mono[i + 1]!; }
  }
  return out;
}

/** 乘增益;超过拐点的部分平滑压缩，不硬削顶。 */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  const room = 32767 - KNEE;
  for (let at = 0; at + 1 < pcm.length; at += 2) {
    const y = pcm.readInt16LE(at) * gain;
    const mag = Math.abs(y);
    const v = mag <= KNEE ? y : Math.sign(y) * (KNEE + room * Math.tanh((mag - KNEE) / room));
    out.writeInt16LE(Math.round(v), at);
  }
  return out;
}

/**
 * 后端候选顺序。Windows 上 RtAudio 自选会先挑 ASIO（厂商 ASIO 驱动不认请求的帧长，第一次写入就越界），
 * 所以默认先 WASAPI；WASAPI 枚举不到设备（issue #4）或打不开时再退 DirectSound（issue #8 的机器也只有它出声）。
 */
export function backendCandidates(setting: AudioBackend): Array<{ api: number | undefined; label: string }> {
  if (process.platform !== 'win32') return [{ api: undefined, label: '默认后端' }];
  const wasapi = { api: 7, label: BACKEND_LABEL.wasapi };
  const ds = { api: 8, label: BACKEND_LABEL.directsound };
  if (setting === 'wasapi') return [wasapi];
  if (setting === 'directsound') return [ds];
  return [wasapi, ds];
}

/** 没有默认设备（RtAudio 返回 0）时，从枚举结果里挑第一个可用设备。 */
export function pickDefaultDevice(devices: Array<{ id: number }>, defaultId: number): number {
  return devices.some((device) => device.id === defaultId) ? defaultId : devices[0]?.id ?? 0;
}

/**
 * 用到时才加载原生模块;加载失败时抛出，由调用方报告。
 * 随包带 audify 1.10.1 官方 napi-v10 win32-x64 预编译件(`vendor/audify/`),不装 npm 的 audify:
 * 它安装时去 GitHub 下预编译件，下不到就现场编译，用户机器没有编译工具就装不上。
 * 枚举值取自 audify 的 index.js。
 */
function loadAudify(): AudifyModule {
  const binding = createRequire(import.meta.url)('../vendor/audify/audify.node') as Pick<AudifyModule, 'RtAudio'>;
  return { RtAudio: binding.RtAudio, RtAudioFormat: { RTAUDIO_SINT16: 0x2 }, RtAudioApi: { WINDOWS_WASAPI: 7, WINDOWS_DS: 8 } };
}

export interface OutputDevice { id: number; name: string; isDefault: boolean }

export function listOutputDevices(backend: AudioBackend = 'auto'): OutputDevice[] {
  const audify = loadAudify();
  for (const candidate of backendCandidates(backend)) {
    try {
      const rt = candidate.api === undefined ? new audify.RtAudio() : new audify.RtAudio(candidate.api);
      const devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      if (!devices.length) continue;
      const def = pickDefaultDevice(devices, rt.getDefaultOutputDevice());
      return devices.map((d) => ({ id: d.id, name: d.name, isDefault: d.id === def }));
    } catch { /* 换下一个后端 */ }
  }
  return [];
}

export interface PlayerOptions {
  /** 输出设备名;空或找不到时用系统默认设备。现读。 */
  device(): string;
  /** 音频后端；现读。 */
  backend(): AudioBackend;
  /** 0–1,现读。 */
  volume(): number;
  log: Logger;
}

export class Player {
  private audify: AudifyModule | null = null;
  private rt: RtAudioLike | null = null;
  private rate = 0;
  /** 当前流用的 RtAudio 后端；默认设备变化时要用同一个后端去查。 */
  private api: number | undefined;
  private openedDevice = '';
  /** 默认设备模式下，流实际打开的设备 id；用来发现系统默认设备被切换。 */
  private defaultId = 0;
  private defaultCheckedAt = 0;
  /** 一帧单声道的字节数;写入时再按声道数展开。 */
  private frameBytes = 0;
  private channels = 1;
  private carry = Buffer.alloc(0);
  /** 写进去的音频预计播完的墙钟时刻。 */
  private endsAt = 0;

  constructor(private readonly opts: PlayerOptions) {}

  /** 正在出声(按写入量估算)。 */
  get playing(): boolean {
    return this.rt !== null && Date.now() < this.endsAt;
  }

  /** 排在已写入的音频后面播放。采样率或设备变了时等前面播完再重开流。 */
  async write(sampleRate: number, raw: Buffer, gain = 1): Promise<void> {
    const pcm = applyGain(raw, gain);
    const device = this.opts.device();
    if (this.rt && (sampleRate !== this.rate || device !== this.openedDevice || this.defaultMoved())) {
      await this.drain();
      this.close();
    }
    if (!this.rt) this.open(sampleRate, device);
    const rt = this.rt!;
    rt.outputVolume = Math.max(0, Math.min(1, this.opts.volume()));
    let buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const whole = buf.length - (buf.length % this.frameBytes);
    for (let at = 0; at < whole; at += this.frameBytes) rt.write(upmix(buf.subarray(at, at + this.frameBytes), this.channels));
    this.carry = Buffer.from(buf.subarray(whole));
    const now = Date.now();
    this.endsAt = Math.max(this.endsAt, now) + (whole / 2 / sampleRate) * 1000;
  }

  /** 一句写完：把不足一帧的尾巴补静音写出去。 */
  flush(): void {
    if (!this.rt || !this.carry.length) return;
    const frame = Buffer.alloc(this.frameBytes);
    this.carry.copy(frame);
    this.rt.write(upmix(frame, this.channels));
    this.endsAt = Math.max(this.endsAt, Date.now()) + FRAME_MS;
    this.carry = Buffer.alloc(0);
  }

  /** 立刻停下，丢掉没播的部分。 */
  cut(): void {
    this.close();
    this.endsAt = 0;
  }

  close(): void {
    this.carry = Buffer.alloc(0);
    if (!this.rt) return;
    try { if (this.rt.isStreamOpen()) this.rt.closeStream(); } catch (err) { this.opts.log.warn('关闭输出流失败', { err: String(err) }); }
    this.rt = null;
  }

  private drain(): Promise<void> {
    const left = this.endsAt - Date.now();
    return left > 0 ? new Promise((done) => setTimeout(done, left)) : Promise.resolve();
  }

  /**
   * 默认设备模式下，系统默认输出是否已经换了（1 秒最多查一次，别每个 20 ms 帧都枚举）。
   * 指定设备时不跟踪：配置里写死哪台就一直用它。
   */
  private defaultMoved(): boolean {
    if (this.openedDevice) return false;
    const now = Date.now();
    if (now - this.defaultCheckedAt < 1000) return false;
    this.defaultCheckedAt = now;
    try {
      const audify = this.audify ??= loadAudify();
      const rt = this.api === undefined ? new audify.RtAudio() : new audify.RtAudio(this.api);
      const devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      if (!devices.length) return false;
      return pickDefaultDevice(devices, rt.getDefaultOutputDevice()) !== this.defaultId;
    } catch {
      return false;
    }
  }

  /**
   * 依次尝试后端：枚举不到设备或打不开就换下一个，全失败才抛错，并把每一家的原因带上。
   * WASAPI 在部分机器上枚举为空（issue #4），有的机器枚举正常但写进去没声音（issue #8，DirectSound 正常），
   * 所以不能只写一个后端。
   */
  private open(sampleRate: number, device: string): void {
    this.audify ??= loadAudify();
    const audify = this.audify;
    const frameSize = Math.round(sampleRate * FRAME_MS / 1000);
    const reasons: string[] = [];
    for (const candidate of backendCandidates(this.opts.backend())) {
      let rt: RtAudioLike;
      try {
        rt = candidate.api === undefined ? new audify.RtAudio() : new audify.RtAudio(candidate.api);
      } catch (err) {
        reasons.push(`${candidate.label}：${String(err)}`);
        continue;
      }
      let devices: Array<{ id: number; name: string; outputChannels: number }>;
      try {
        devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      } catch (err) {
        reasons.push(`${candidate.label}：枚举设备失败（${String(err)}）`);
        continue;
      }
      if (!devices.length) {
        reasons.push(`${candidate.label}：没有枚举到播放设备`);
        continue;
      }
      const wanted = device ? devices.find((d) => d.name === device) ?? devices.find((d) => d.name.includes(device)) : undefined;
      const deviceId = wanted?.id ?? pickDefaultDevice(devices, rt.getDefaultOutputDevice());
      const channels = Math.min(2, Math.max(1, devices.find((d) => d.id === deviceId)?.outputChannels ?? 2));
      try {
        rt.openStream({ deviceId, nChannels: channels, firstChannel: 0 }, null, audify.RtAudioFormat.RTAUDIO_SINT16, sampleRate, frameSize, 'cortico-gpt-sovits', null, null);
        rt.start();
      } catch (err) {
        reasons.push(`${candidate.label}：打不开「${devices.find((d) => d.id === deviceId)?.name ?? deviceId}」（${String(err)}）`);
        try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
        continue;
      }
      this.rt = rt;
      this.api = candidate.api;
      this.rate = sampleRate;
      this.openedDevice = device;
      this.defaultId = deviceId;
      this.defaultCheckedAt = Date.now();
      this.frameBytes = frameSize * 2;
      this.channels = channels;
      this.endsAt = 0;
      this.opts.log.info(`音频输出已打开：${candidate.label}`, { devices: devices.length, device: devices.find((d) => d.id === deviceId)?.name ?? deviceId });
      return;
    }
    throw new Error(`打不开输出设备：${reasons.join('；')}。请在「输出与保存」里换一个设备或后端，或留空用系统默认。`);
  }
}
