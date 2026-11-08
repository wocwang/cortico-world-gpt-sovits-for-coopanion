/**
 * 本机声卡播放：PCM16 单声道经 audify(RtAudio,Windows 上走 WASAPI)按到达顺序写进一条输出流。
 * 设备有两个以上输出声道时开双声道流，每个样本复制到左右两路;只开一个声道时 RtAudio 只送进左声道。
 * audify 的输出队列无界、`write()` 不阻塞，所以排队即顺序;`cut()` 关流丢弃队列里没播的部分。
 * 播完时刻按写入的帧数换算墙钟，只用来报「正在说」。
 *
 * macOS 上没有随包的 audify 预编译件：改成「每次 `flush()` 把这段 PCM 落成临时 WAV，交给系统自带的 `afplay` 依次播」，
 * `cut()` 把正在播的和队列一起停掉。增益与软限幅仍在 Player 里做，afplay 只负责出声。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { useSystemPlayer } from './platform.ts';
import { wavBytes } from './wav.ts';

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
  /** 开流成功但没在跑（issue #8 的 WASAPI）时会是 false；随包 audify 有这个符号，旧包没有。 */
  isStreamRunning?(): boolean;
  outputVolume: number;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_SINT16: number };
  RtAudioApi: { WINDOWS_WASAPI: number; WINDOWS_DS: number };
}

/**
 * 音频后端：`auto` 先 WASAPI、枚举不到或打不开再退 DirectSound（issue #4 的机器上 WASAPI 返回空表）；
 * `system` 完全不加载 audify，把整句落成 WAV 交给系统播放器（Windows 用 SoundPlayer、macOS 用 afplay），
 * 用来绕开声卡驱动里的原生崩溃（issue #13：RtAudio openStream 访问违例，JS 层接不住）。
 */
export type AudioBackend = 'auto' | 'wasapi' | 'directsound' | 'system';

const BACKEND_LABEL: Record<Exclude<AudioBackend, 'auto'>, string> = { wasapi: 'WASAPI', directsound: 'DirectSound', system: '系统播放器' };

/**
 * 每次写入的帧长:40 ms。原来是 20 ms，合成稍慢或网络抖一下就会出现「写不进去 → 空一段 → 再续上」的断续，
 * 听起来像按标点卡顿；40 ms 的缓冲只多 40 ms 延迟，换来的连续性好很多。
 */
const FRAME_MS = 40;

/** 软限幅的拐点：绝对值超过它的样本按 tanh 压到满幅以内。 */
const KNEE = 24000;

/** 预缓冲门槛的上限：低于「第一次写声卡」的 3 秒回执等待，气泡不会早于声音太多。 */
export const LEAD_CAP_MS = 2400;

/** 实测生成至少要慢于播放这么多（实时系数 RTF）才值得预缓冲；贴得太近时缓冲只会白等。 */
export const LEAD_MIN_RTF = 1.05;

/**
 * 预缓冲门槛（毫秒），0 表示不缓冲、第一块就播。
 * `ratio` 是「先攒够本句预计时长的比例」；`secondsPerChar` / `rtf` 来自最近几句的实测。
 * 生成快于播放、没有历史样本、或本句不落声卡时一律给 0——那时等只会增加首声延迟。
 */
export function playbackLeadMs(opts: {
  ratio: number;
  chars: number;
  secondsPerChar: number;
  rtf: number;
  capMs?: number;
}): number {
  const { ratio, chars, secondsPerChar, rtf } = opts;
  if (!(ratio > 0) || !(ratio <= 1)) return 0;
  if (!(chars > 0) || !(secondsPerChar > 0) || !(rtf > 0)) return 0;
  if (rtf < LEAD_MIN_RTF) return 0;
  const cap = opts.capMs ?? LEAD_CAP_MS;
  const ms = Math.min(ratio * secondsPerChar * chars * 1000, cap);
  // 门槛太小时不值得为它压住第一块；80 ms 也是 audify 的两帧。
  return ms >= 80 ? Math.round(ms) : 0;
}

/** 单声道 PCM16 复制成 `channels` 路交错。 */
export function upmix(mono: Buffer, channels: number): Buffer {
  if (channels === 1) return mono;
  const out = Buffer.alloc(mono.length * channels);
  for (let i = 0, o = 0; i + 1 < mono.length; i += 2) {
    for (let c = 0; c < channels; c++, o += 2) { out[o] = mono[i]!; out[o + 1] = mono[i + 1]!; }
  }
  return out;
}

/**
 * audify 的 `write()` 只接受**正好一帧**：`frameSize` 个采样 × 声道数 × 2 字节。
 * 少一个字节、多一帧都抛 `Invalid size of the PCM data!`。
 * 0.6.4 的探针送了两帧（`frameBytes * channels * 2`），抛错被吞掉后两只后端都被判死，
 * 结果那版在 Windows 上全员静音——长度只能有一处算法，并且要有单测盯着。
 */
export function oneFrameBytes(frameSize: number, channels: number): number {
  return frameSize * channels * 2;
}

/**
 * 探针结论：只有「写帧成功、而且流停了」才判这个后端死了。
 * 探针自己写失败（长度算错之类）没有证据力，放行后端——0.6.4 就是把写失败当成「流停了」，
 * 结果两只后端全被判死，所有人静音。
 */
export function probeVerdict(writeOk: boolean, running: boolean): 'alive' | 'dead' | 'unknown' {
  if (!writeOk) return 'unknown';
  return running ? 'alive' : 'dead';
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
 * 手动改 `config.json` 时很容易照着描述写成 `DirectSound`、`WASAPI` 或带空格。
 * `?? 'auto'` 挡不住「存在但非法」的值，所以统一在这里归一化；认不出的按 `auto`。
 */
export function normalizeAudioBackend(setting: unknown): AudioBackend {
  const value = typeof setting === 'string' ? setting.trim().toLowerCase() : '';
  if (value === 'wasapi') return 'wasapi';
  if (value === 'directsound' || value === 'direct sound' || value === 'ds') return 'directsound';
  if (value === 'system' || value === 'external' || value === 'soundplayer') return 'system';
  return 'auto';
}

/**
 * 后端候选顺序。Windows 上 RtAudio 自选会先挑 ASIO（厂商 ASIO 驱动不认请求的帧长，第一次写入就越界），
 * 所以默认先 WASAPI；WASAPI 枚举不到设备（issue #4）或打不开时再退 DirectSound（issue #8 的机器也只有它出声）。
 */
export function backendCandidates(setting: string): Array<{ api: number | undefined; label: string }> {
  if (process.platform !== 'win32') return [{ api: undefined, label: '默认后端' }];
  const wasapi = { api: 7, label: BACKEND_LABEL.wasapi };
  const ds = { api: 8, label: BACKEND_LABEL.directsound };
  const backend = normalizeAudioBackend(setting);
  if (backend === 'wasapi') return [wasapi];
  if (backend === 'directsound') return [ds];
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
  // 系统播放器不经过 RtAudio，没有可枚举的设备：面板只留「系统默认」。
  if (useSystemPlayer() || normalizeAudioBackend(backend) === 'system') return [];
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
  /** 系统播放器：临时 WAV 的目录（用到时才建）。 */
  private sysDir: string | null = null;
  /** 系统播放器：正在播的那一条（afplay / PowerShell SoundPlayer）。 */
  private sysChild: ChildProcess | null = null;
  /** 只提醒一次「后端配置认不出」，别每帧刷日志。 */
  private warnedBackend = false;
  /** 系统播放器：排着的临时 WAV 与它的时长。 */
  private sysQueue: Array<{ file: string; ms: number }> = [];
  private sysSeq = 0;

  constructor(private readonly opts: PlayerOptions) {}

  /** 系统播放器：macOS 一直用；Windows 选了「系统播放器」后端时用（绕开 RtAudio 原生崩溃）。 */
  private systemMode(): boolean {
    return useSystemPlayer() || normalizeAudioBackend(this.opts.backend()) === 'system';
  }

  /** 系统播放器整句落盘后才出声，播放侧不需要（也不该）预缓冲。 */
  get usesSystemPlayer(): boolean {
    return this.systemMode();
  }

  /** 正在出声(按写入量估算)。 */
  get playing(): boolean {
    if (this.systemMode()) return this.sysChild !== null || this.sysQueue.length > 0;
    return this.rt !== null && Date.now() < this.endsAt;
  }

  /** 排在已写入的音频后面播放。采样率或设备变了时等前面播完再重开流。 */
  async write(sampleRate: number, raw: Buffer, gain = 1): Promise<void> {
    const pcm = applyGain(raw, gain);
    // 系统播放器：先攒着，`flush()` 时整段落盘交出去，避免几十毫秒一个进程。
    if (this.systemMode()) {
      this.rate = sampleRate;
      this.carry = Buffer.from(this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm);
      return;
    }
    const device = this.opts.device();
    if (this.rt && (sampleRate !== this.rate || device !== this.openedDevice || this.defaultMoved())) {
      await this.drain();
      this.close();
    }
    if (!this.rt) await this.open(sampleRate, device);
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
    if (this.systemMode()) {
      const pcm = this.carry;
      this.carry = Buffer.alloc(0);
      if (pcm.length) this.enqueueSystem(pcm, this.rate);
      return;
    }
    if (!this.rt || !this.carry.length) return;
    const frame = Buffer.alloc(this.frameBytes);
    this.carry.copy(frame);
    this.rt.write(upmix(frame, this.channels));
    this.endsAt = Math.max(this.endsAt, Date.now()) + FRAME_MS;
    this.carry = Buffer.alloc(0);
  }

  /** 立刻停下，丢掉没播的部分。 */
  cut(): void {
    if (this.systemMode()) {
      this.stopSystem();
      this.carry = Buffer.alloc(0);
      return;
    }
    this.close();
    this.endsAt = 0;
  }

  close(): void {
    if (this.systemMode()) {
      this.stopSystem();
      this.carry = Buffer.alloc(0);
      this.removeSystemDir();
      return;
    }
    this.carry = Buffer.alloc(0);
    if (!this.rt) return;
    try { if (this.rt.isStreamOpen()) this.rt.closeStream(); } catch (err) { this.opts.log.warn('关闭输出流失败', { err: String(err) }); }
    this.rt = null;
  }

  /** 系统播放器：把一段 PCM 落成临时 WAV 排进播放队列。音量在这里预乘（SoundPlayer 没有音量参数）。 */
  private enqueueSystem(pcm: Buffer, sampleRate: number): void {
    try {
      const volume = Math.max(0, Math.min(1, this.opts.volume()));
      const scaled = volume === 1 ? pcm : applyGain(pcm, volume);
      this.sysDir ??= mkdtempSync(join(tmpdir(), 'cortico-gpt-sovits-'));
      const file = join(this.sysDir, `line-${Date.now()}-${this.sysSeq++}.wav`);
      writeFileSync(file, wavBytes(scaled, sampleRate));
      this.sysQueue.push({ file, ms: (pcm.length / 2 / sampleRate) * 1000 });
      this.pumpSystem();
    } catch (err) {
      this.opts.log.warn('系统播放器：临时 WAV 写不出来', { err: String(err) });
    }
  }

  /** 系统播放器命令：macOS 用 afplay（自带音量），Windows 用 PowerShell 的 SoundPlayer 阻塞播放。 */
  private systemCommand(file: string): { cmd: string; args: string[] } {
    if (process.platform === 'darwin') {
      const volume = Math.max(0, Math.min(1, this.opts.volume()));
      return { cmd: '/usr/bin/afplay', args: ['-v', volume.toFixed(2), file] };
    }
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const escaped = file.replace(/'/g, "''");
    return {
      cmd: ps,
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`],
    };
  }

  /** 系统播放器：当前没在播就取队列里的下一条。 */
  private pumpSystem(): void {
    if (this.sysChild || !this.sysQueue.length) return;
    const item = this.sysQueue.shift()!;
    const { cmd, args } = this.systemCommand(item.file);
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    this.sysChild = child;
    this.endsAt = Date.now() + item.ms;
    const finish = (): void => {
      rmSync(item.file, { force: true });
      if (this.sysChild !== child) return;
      this.sysChild = null;
      this.pumpSystem();
    };
    child.once('exit', finish);
    child.once('error', (err) => {
      this.opts.log.warn('系统播放器起不来', { err: String(err), cmd });
      finish();
    });
  }

  /** 系统播放器：停掉正在播的一条（Windows 连子进程树一起杀），清空队列与缓冲。 */
  private stopSystem(): void {
    const child = this.sysChild;
    this.sysChild = null;
    if (child && child.exitCode === null) {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* 已经退出 */ }
    }
    for (const item of this.sysQueue) rmSync(item.file, { force: true });
    this.sysQueue = [];
    this.endsAt = 0;
  }

  private removeSystemDir(): void {
    const dir = this.sysDir;
    this.sysDir = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
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
   * WASAPI 在部分机器上枚举为空（issue #4），有的机器枚举正常、开流也成功但写进去没声音（issue #8），
   * 所以不能只写一个后端，还要在开流后验一下它是不是真的在跑。
   */
  private async open(sampleRate: number, device: string): Promise<void> {
    // 系统播放器不碰 RtAudio；write() 已经分流，这里只是防御。
    if (this.systemMode()) return;
    this.audify ??= loadAudify();
    const audify = this.audify;
    const frameSize = Math.round(sampleRate * FRAME_MS / 1000);
    const reasons: string[] = [];
    const requested = this.opts.backend();
    if (!this.warnedBackend && normalizeAudioBackend(requested) !== requested) {
      this.warnedBackend = true;
      this.opts.log.warn('音频后端配置无法识别，按 auto 处理', { value: String(requested) });
    }
    for (const candidate of backendCandidates(requested)) {
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
      const frameBytes = frameSize * 2;
      try {
        rt.openStream({ deviceId, nChannels: channels, firstChannel: 0 }, null, audify.RtAudioFormat.RTAUDIO_SINT16, sampleRate, frameSize, 'cortico-gpt-sovits', null, null);
        rt.start();
      } catch (err) {
        reasons.push(`${candidate.label}：打不开「${devices.find((d) => d.id === deviceId)?.name ?? deviceId}」（${String(err)}）`);
        try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
        continue;
      }
      // 开流 + start 都成功也可能是「假成功」：issue #8 的机器上 WASAPI 约 100 ms 内自己停掉，
      // 看起来一切正常但没有声音。写**正好一帧**静音等 120 ms 再查 isStreamRunning，就能把这类机器挑出来。
      if (typeof rt.isStreamRunning === 'function') {
        let writeOk = true;
        let running = true;
        try {
          rt.write(Buffer.alloc(oneFrameBytes(frameSize, channels)));
          await new Promise((done) => setTimeout(done, 120));
          running = rt.isStreamRunning();
        } catch (err) {
          // 探针自己写失败（长度算错之类）**不能**据此判后端死刑——0.6.4 就是这么把所有人的声音掐掉的。
          // 探测不出来就当「没证据」，放行这个后端，并把原因写进日志。
          writeOk = false;
          this.opts.log.warn('音频后端探针写帧失败，跳过这次探测', { backend: candidate.label, err: String(err) });
        }
        if (probeVerdict(writeOk, running) === 'dead') {
          reasons.push(`${candidate.label}：开流成功但 120 ms 内停止运行（能开流却没声音，issue #8）`);
          try { if (rt.isStreamOpen()) rt.closeStream(); } catch { /* 已断开 */ }
          continue;
        }
      }
      this.rt = rt;
      this.api = candidate.api;
      this.rate = sampleRate;
      this.openedDevice = device;
      this.defaultId = deviceId;
      this.defaultCheckedAt = Date.now();
      this.frameBytes = frameBytes;
      this.channels = channels;
      this.endsAt = 0;
      this.opts.log.info(`音频输出已打开：${candidate.label}`, { devices: devices.length, device: devices.find((d) => d.id === deviceId)?.name ?? deviceId });
      return;
    }
    throw new Error(`打不开输出设备：${reasons.join('；')}。请在「输出与保存」里换一个设备或后端，或留空用系统默认。`);
  }
}
