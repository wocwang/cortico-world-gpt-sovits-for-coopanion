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
  RtAudioApi: { WINDOWS_WASAPI: number };
}

/** 每次写入的帧长:20 ms。 */
const FRAME_MS = 20;

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
 * Windows 上指定 WASAPI:RtAudio 自选时会先挑 ASIO,厂商 ASIO 驱动不认请求的帧长，第一次写入就越界。
 */
const apiOf = (a: AudifyModule): number | undefined => (process.platform === 'win32' ? a.RtAudioApi.WINDOWS_WASAPI : undefined);

/**
 * 用到时才加载原生模块;加载失败时抛出，由调用方报告。
 * 随包带 audify 1.10.1 官方 napi-v10 win32-x64 预编译件(`vendor/audify/`),不装 npm 的 audify:
 * 它安装时去 GitHub 下预编译件，下不到就现场编译，用户机器没有编译工具就装不上。
 * 枚举值取自 audify 的 index.js。
 */
function loadAudify(): AudifyModule {
  const binding = createRequire(import.meta.url)('../vendor/audify/audify.node') as Pick<AudifyModule, 'RtAudio'>;
  return { RtAudio: binding.RtAudio, RtAudioFormat: { RTAUDIO_SINT16: 0x2 }, RtAudioApi: { WINDOWS_WASAPI: 7 } };
}

export interface OutputDevice { id: number; name: string; isDefault: boolean }

export function listOutputDevices(): OutputDevice[] {
  const audify = loadAudify();
  const rt = new audify.RtAudio(apiOf(audify));
  const def = rt.getDefaultOutputDevice();
  return rt.getDevices().filter((d) => d.outputChannels > 0).map((d) => ({ id: d.id, name: d.name, isDefault: d.id === def }));
}

export interface PlayerOptions {
  /** 输出设备名;空或找不到时用系统默认设备。现读。 */
  device(): string;
  /** 0–1,现读。 */
  volume(): number;
  log: Logger;
}

export class Player {
  private audify: AudifyModule | null = null;
  private rt: RtAudioLike | null = null;
  private rate = 0;
  private openedDevice = '';
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
    if (this.rt && (sampleRate !== this.rate || device !== this.openedDevice)) {
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

  private open(sampleRate: number, device: string): void {
    this.audify ??= loadAudify();
    const audify = this.audify;
    let rt = new audify.RtAudio(apiOf(audify));
    let devices = rt.getDevices().filter((d) => d.outputChannels > 0);
    const wanted = device ? devices.find((d) => d.name === device) ?? devices.find((d) => d.name.includes(device)) : undefined;
    let deviceId = wanted?.id ?? rt.getDefaultOutputDevice();
    const frameSize = Math.round(sampleRate * FRAME_MS / 1000);
    const channelsOf = (id: number): number => Math.min(2, Math.max(1, devices.find((d) => d.id === id)?.outputChannels ?? 2));
    const openOn = (): number => {
      rt.openStream({ deviceId, nChannels: channelsOf(deviceId), firstChannel: 0 }, null, audify.RtAudioFormat.RTAUDIO_SINT16, sampleRate, frameSize, 'cortico-gpt-sovits', null, null);
      rt.start();
      return channelsOf(deviceId);
    };
    let channels: number;
    try {
      channels = openOn();
    } catch (err) {
      if (!wanted) throw new Error(`打不开输出设备：${String(err)}。请在「输出与保存」里换一个设备，或留空用系统默认。`);
      // 配置里写的设备当前不可用（拔掉耳机、驱动重排）：退回系统默认，别让整句合成失败。
      this.opts.log.warn('指定输出设备打不开，改用系统默认', { device, err: String(err) });
      try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
      rt = new audify.RtAudio(apiOf(audify));
      devices = rt.getDevices().filter((d) => d.outputChannels > 0);
      deviceId = rt.getDefaultOutputDevice();
      channels = openOn();
    }
    this.rt = rt;
    this.rate = sampleRate;
    this.openedDevice = device;
    this.frameBytes = frameSize * 2;
    this.channels = channels;
    this.endsAt = 0;
  }
}
