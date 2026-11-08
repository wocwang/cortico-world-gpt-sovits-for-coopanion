/**
 * 交接快照：把「现在到底什么状态」写成一份 Markdown，下次开新会话直接读它。
 *
 * 用法：
 *   node scripts/handoff.mjs            # 打印到终端
 *   node scripts/handoff.mjs --write    # 同时写进 docs/STATE.md
 *
 * 环境变量可覆盖路径：
 *   COOPANION_DATA  宿主数据目录（默认 D:/Program Files/Coopanion/data）
 *
 * 只读：不动配置、不动安装、不写仓库以外的东西。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const DATA = process.env.COOPANION_DATA ?? 'D:/Program Files/Coopanion/data';
const write = process.argv.includes('--write');

const run = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 15000, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return null;
  }
};

const lines = [];
const push = (...xs) => lines.push(...xs);

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
push('# 当前状态快照', '');
push(`生成时间：${new Date().toISOString()}`);
push(`仓库：${REPO}`);
push('');

// ---- 版本与发布状态
const registry = await (async () => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const doc = await res.json();
    return { latest: doc['dist-tags']?.latest, tags: doc['dist-tags'] ?? {}, time: doc.time?.[pkg.version] };
  } catch {
    return null;
  }
})();
push('## 版本', '');
push(`- 工作区：**${pkg.version}**（package.json）`);
if (registry?.latest) {
  push(`- npm latest：**${registry.latest}**${registry.latest === pkg.version ? '（与工作区一致）' : '（与工作区不同）'}`);
  for (const [tag, v] of Object.entries(registry.tags)) if (tag !== 'latest') push(`- npm ${tag}：${v}`);
  if (registry.time) push(`- 当前版本发布时间：${registry.time}`);
} else {
  push('- npm latest：查不到（离线）');
}
push('');

// ---- 提交与工作树
push('## 提交', '');
const log = run('git', ['log', '--oneline', '-8']);
push('```', log ?? '（取不到）', '```', '');
const status = run('git', ['status', '--short']);
const dirty = (status ?? '').split(/\r?\n/).filter(Boolean).filter((l) => !/docs\/STATE\.md$/.test(l.trim()));
push('## 工作树', '');
if (!dirty.length) push('- 干净（无未提交改动）');
else for (const l of dirty) {
  const note = /AGENTS\.md|CLAUDE\.md/.test(l) ? '（别的工具生成的，未跟踪）' : '';
  push(`- \`${l}\`${note}`);
}
push('');

// ---- 本机安装状态
const installed = join(DATA, 'extensions/node_modules/@wocwang/cortico-world-gpt-sovits-for-coopanion/package.json');
push('## 本机安装', '');
if (existsSync(installed)) {
  const v = JSON.parse(readFileSync(installed, 'utf8')).version;
  push(`- 已装版本：**${v}**${v === pkg.version ? '（与工作区一致）' : '（与工作区不同，发布后需要重装）'}`);
} else {
  push('- 没找到已安装的插件包');
}
const logTail = join(DATA, 'logs/core.log');
if (existsSync(logTail)) {
  const st = statSync(logTail);
  push(`- 日志：\`${logTail}\`（最后写入 ${new Date(st.mtimeMs).toISOString()}）`);
}
push('');

// ---- 宿主配置要点
const cfgPath = join(DATA, 'home/companion/config.json');
push('## 宿主配置（gpt-sovits）', '');
if (existsSync(cfgPath)) {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const w = cfg.worlds?.['gpt-sovits'] ?? {};
  const pick = (k) => (w[k] === undefined ? '（未设置）' : typeof w[k] === 'string' ? (w[k] || '（空）') : JSON.stringify(w[k]));
  push(`- 语音引擎：${pick('ttsEngine')}`);
  push(`- 推理档：${pick('tier')}　模型版本：${pick('voiceModel')}　文本语言：${pick('textLang')}`);
  push(`- 当前音色：${pick('voice')}`);
  push(`- 权重：${pick('weights')}`);
  push(`- 自定义音色：${(w.voices ?? []).map((v) => `${v.name}(${v.id})`).join('、') || '（无）'}`);
  push(`- 联动开关：channelVoice=${pick('channelVoice')} qqbotVoice=${pick('qqbotVoice')} httpApi=${pick('httpApi')} shareAudio=${pick('shareAudio')}`);
  if (w.cloudBaseUrl !== undefined) {
    push(`- 云端：地址=${pick('cloudBaseUrl')} 模型=${pick('cloudModel')} 音色=${pick('cloudVoiceId')} 密钥已设=${w.cloudKeyMask ? '是' : '否'}`);
  }
} else {
  push('- 没找到 config.json');
}
push('');

// ---- 训练产物
const trainers = join(DATA, 'home/companion/data/trainers');
push('## 训练产物', '');
if (existsSync(trainers)) {
  for (const dir of readdirSync(trainers)) {
    const base = join(trainers, dir);
    if (!statSync(base).isDirectory()) continue;
    const note = join(base, 'NOTE.md');
    const exp = join(base, 'exp');
    push(`- \`${dir}\`${existsSync(note) ? '（有 NOTE.md）' : ''}${existsSync(exp) ? '（有 exp/）' : ''}`);
  }
} else {
  push('- 没有 trainers 目录');
}
const record = join(DATA, 'shi-training.md');
if (existsSync(record)) push(`- 训练记录：\`${record}\``);
push('');

const out = `${lines.join('\n')}\n`;
if (write) {
  const target = join(REPO, 'docs/STATE.md');
  mkdirSync(join(REPO, 'docs'), { recursive: true });
  writeFileSync(target, out);
  push(`已写入 ${target}`);
}
process.stdout.write(out);
