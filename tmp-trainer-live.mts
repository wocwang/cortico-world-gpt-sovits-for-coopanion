import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { TrainerManager } from './src/trainer.ts';
import { patchTrainer } from './src/runtime-patch.ts';

const RUNTIME = 'D:\\Program Files\\Coopanion\\data\\home\\runtimes\\gpt-sovits\\e91506f-1\\cuda';
const WEIGHTS = 'D:\\Program Files\\Coopanion\\data\\home\\models\\gpt-sovits\\pretrained_models';
const DATA = 'D:\\Program Files\\Coopanion\\data\\home\\companion\\data\\gpt-sovits';
const log = console as unknown as Logger;

const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const say = (...a: unknown[]) => console.log(ts(), ...a);

let failReason: string | null = null;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    say(`ASSERT OK   ${name}`);
  } else {
    say(`ASSERT FAIL ${name}`, extra ?? '');
    if (!failReason) failReason = name;
  }
}

const mgr = new TrainerManager({
  runtimeDir: () => RUNTIME,
  weightsDir: () => WEIGHTS,
  dataDir: DATA,
  log,
  stopInference: async () => {
    throw new Error('stopInference 不应被调用');
  },
  modelVersion: () => 'v5turbo',
});

try {
  // ---- patch ----
  say('== patch ==');
  const p1 = patchTrainer(RUNTIME);
  say('patch-1', p1);
  const p2 = patchTrainer(RUNTIME);
  say('patch-2', p2);
  check('patch 结果合法且第二次为 already', ['patched', 'already'].includes(p1) && p2 === 'already', { p1, p2 });

  // ---- deps ----
  say('== installDeps ==');
  await mgr.installDeps();
  const s1 = mgr.state();
  say('deps state:', { deps: s1.deps, depsError: s1.depsError });
  check('deps === ready', s1.deps === 'ready', s1);
  check('depsError === null', s1.depsError === null, s1.depsError);

  // ---- assets ----
  say('== downloadAssets ==');
  await mgr.downloadAssets();
  const s2 = mgr.state();
  say('assets state:', JSON.stringify({ assetsReady: s2.assetsReady, assets: s2.assets, assetsError: s2.assetsError }));
  check('assetsReady === true', s2.assetsReady === true, s2);
  for (const a of s2.assets) {
    const disk = join(WEIGHTS, a.name);
    let size = -1;
    try {
      size = statSync(disk).size;
    } catch { /* 不存在 */ }
    say(`asset on disk: ${a.name} declared=${a.bytes} ready=${a.ready} diskSize=${size}`);
    check(`asset ${a.name} 落盘字节数一致`, size === a.bytes, { declared: a.bytes, diskSize: size });
  }
  try {
    say('dir 校验:\n' + execSync(`dir "${join(WEIGHTS, 'v2Pro')}"`, { encoding: 'utf8' }));
  } catch (e) {
    say('dir 失败', (e as Error).message);
  }

  // ---- start ----
  say('== start ==');
  await mgr.start({ stopInference: false });
  const s3 = mgr.state();
  say('start state:', JSON.stringify({ running: s3.running, starting: s3.starting, port: s3.port, url: s3.url }));
  check('running && url', s3.running === true && !!s3.url, s3);
  const port = s3.port;
  if (!port) throw new Error('没有拿到端口，无法继续');
  const url = `http://127.0.0.1:${port}`;

  say('== HTTP GET / ==');
  let httpStatus = -1;
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(10000) });
    httpStatus = res.status;
    await res.body?.cancel();
  } catch (e) {
    say('HTTP 失败:', (e as Error).message);
  }
  say('HTTP status =', httpStatus);
  check('HTTP status < 500', httpStatus > 0 && httpStatus < 500, httpStatus);

  say('== netstat (训练端口) ==');
  let net = '';
  try {
    net = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  } catch { net = ''; }
  say('netstat raw:\n' + (net.trim() || '<空>'));
  const listenLine = net.split(/\r?\n/).find((l) => /LISTENING/i.test(l)) ?? '';
  say('LISTENING line:', listenLine.trim() || '<无>');
  check('LISTENING 绑定 127.0.0.1', /127\.0\.0\.1:/.test(listenLine) && !/0\.0\.0\.0:/.test(listenLine), listenLine);
  const pidMatch = listenLine.match(/(\d+)\s*$/);
  const trainPid = pidMatch ? pidMatch[1] : null;
  say('训练 webui pid =', trainPid);

  say('== webui.py 补丁标记 ==');
  const marker = execSync(`findstr /C:"_coopanion_trainer_patch" "${join(RUNTIME, 'webui.py')}"`, { encoding: 'utf8' }).trim();
  say('findstr 命中:', marker ? '是' : '否');
  check('webui.py 含 _coopanion_trainer_patch', marker.length > 0, marker);

  // ---- stop ----
  say('== stop ==');
  await mgr.stop();
  const s4 = mgr.state();
  say('stop state:', JSON.stringify({ running: s4.running, starting: s4.starting, port: s4.port, url: s4.url }));
  check('stop 后 running=false', s4.running === false, s4);

  await new Promise((r) => setTimeout(r, 3000));
  let netAfter = '';
  try {
    netAfter = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  } catch { netAfter = ''; }
  say('stop 后 netstat raw:\n' + (netAfter.trim() || '<空>'));
  const stillListening = netAfter.split(/\r?\n/).some((l) => /LISTENING/i.test(l));
  check('stop 后端口已释放(无 LISTENING)', !stillListening, netAfter);

  if (trainPid) {
    let tl = '';
    try {
      tl = execSync(`tasklist /FI "PID eq ${trainPid}" /NH`, { encoding: 'utf8' });
    } catch { tl = ''; }
    say('tasklist(PID ' + trainPid + '):\n' + (tl.trim() || '<空>'));
    const dead = !new RegExp(`\\b${trainPid}\\b`).test(tl) || /No tasks|信息: 没有运行的任务|INFO: No tasks/.test(tl);
    check('训练 python.exe 已退出', dead, tl);
  }
} catch (e) {
  say('异常退出:', (e as Error).stack ?? (e as Error).message);
  if (!failReason) failReason = `exception: ${(e as Error).message}`;
}

if (failReason) {
  say(`FAIL: ${failReason}`);
  process.exit(1);
} else {
  say('OK');
  process.exit(0);
}
