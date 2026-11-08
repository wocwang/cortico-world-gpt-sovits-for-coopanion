/**
 * 「语音」面板：推理档、运行时、权重、推理服务四行状态与操作，以及试听。
 * 「音色」面板（第二个）：自定义音色的新建/编辑/删除/切换，保存立即生效。
 * 数据经 `ctx.invoke` 走 World 的 `invoke(<panel>, …)`,每秒轮询一次状态。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext, WebUiSheet } from 'cortico/web/shared/client-panel.ts';
import { panelText } from '../i18n.ts';
import type { RvcProbe } from '../rvc-link.ts';
import type { PanelState, UsageItem, UsageState } from '../world.ts';
import type { TrainerState } from '../trainer.ts';
import { VOICE_PRESETS, isPreset, presetFileLabel, presetLabel } from '../voices.ts';
import './style.css';

const MB = (n: number) => Math.round(n / 1048576);
/** 面板里显示体积：过 1 GB 用 GB，否则 MB。 */
const sizeText = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${Math.max(1, MB(n))} MB`);
const pct = (done: number, total: number) => (total ? `${Math.round((done / total) * 100)}%` : `${MB(done)} MB`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
/** 推理模型的展示名。 */
const modelLabel = (v: string): string => (v === 'v5turbo' ? 'V5 turbo' : 'V2 Pro Plus');
/** 一次性回执（换音色自动对齐模型 / 保存了版本不一致的权重 / 拉到云端音色清单）。 */
const noticeText = (n: NonNullable<PanelState['notice']>, t: ReturnType<typeof panelText>): { text: string; bad: boolean } => {
  if (n.code === 'modelSwitched') return { text: t.modelSwitched(modelLabel(n.model)), bad: false };
  if (n.code === 'cloudVoicesPulled') return { text: t.cloudVoicesPulled(n.count), bad: false };
  return { text: t.weightsMismatch(modelLabel(n.want), modelLabel(n.current)), bad: true };
};

/** 云端就绪摘要 / 没就绪的原因；「语音」页与「音色」页共用同一份文案。 */
const cloudSummary = (s: PanelState, t: ReturnType<typeof panelText>): string => {
  const why = !s.cloud.baseUrl.trim() ? t.cloudWhyBase
    : !s.cloud.voiceId.trim() ? t.cloudWhyVoice
      : !s.cloud.keySet ? t.cloudWhyKey
        : t.cloudKeyUnreadable;
  return s.cloud.ready ? t.cloudReadyNote(s.cloud.baseUrl, s.cloud.voiceId) : t.cloudNotReady(why);
};

const voicePanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;

    const call = async (method: string, args: unknown[] = []) => {
      msg.textContent = '';
      try {
        const next = await ctx.invoke<PanelState | { text: string; failed?: true }>(method, args);
        if (next && 'backend' in next) {
          render(next);
          if (next.notice) {
            const { text, bad } = noticeText(next.notice, t);
            msg.textContent = text;
            msg.classList.toggle('bad', bad);
            ui.toast(text);
          }
        } else if (next && 'text' in next) { msg.textContent = next.text; msg.classList.toggle('bad', !!next.failed); }
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

    // ---- L0：语音引擎（下拉；放在页首，新用户第一件事就是选本地还是云端）
    const engineSec = ui.section(t.engineTitle, t.engineHint);
    const engineSel = ui.select({ onChange: (v) => { if (v) void call('setEngine', [v]); } });
    for (const [value, label] of [['', t.engineChoose], ['local', t.engineLocal], ['cloud', t.engineCloud]] as const) {
      const option = ui.h('option', null, label);
      option.value = value;
      engineSel.append(option);
    }
    const engineUnset = ui.h('div', 'gsv-detail', t.engineUnset);
    const engineCloudNote = ui.h('div', 'gsv-detail');
    const engineMismatch = ui.h('div', 'gsv-detail');
    engineSec.append(engineSel, engineUnset, engineCloudNote, engineMismatch);

    // ---- 状态四行
    const status = ui.section(t.panel, t.panelHint);
    const row = (name: string, parent: HTMLElement = status) => {
      const el = ui.h('div', 'gsv-row');
      const label = ui.h('span', 'gsv-name', name);
      const pill = ui.h('span', 'gsv-pill');
      const detail = ui.h('span', 'gsv-detail');
      const acts = ui.h('span', 'gsv-acts');
      el.append(label, pill, detail, acts);
      parent.append(el);
      return { pill, detail, acts };
    };
    const tierRow = row(t.tier), runtimeRow = row(t.runtime), weightsRow = row(t.weights), trainedRow = row(t.trained), serverRow = row(t.server);
    const installBtn = ui.button(t.install, { variant: 'primary', size: 'sm', onClick: () => void call('install') });
    const cancelBtn = ui.button(t.cancel, { size: 'sm', onClick: () => void call('cancel') });
    runtimeRow.acts.append(installBtn, cancelBtn);
    const startBtn = ui.button(t.start, { size: 'sm', onClick: () => void call('start') });
    const stopBtn = ui.button(t.stop, { size: 'sm', onClick: () => void call('stop') });
    serverRow.acts.append(startBtn, stopBtn);
    // 底部吸附条：重启引擎始终在页脚，滚动时不离开视野。
    let restartLock = 0;
    const restartBar = ui.actions();
    restartBar.classList.add('gsv-restartbar');
    restartBar.hidden = true;
    const restartNote = ui.h('span', 'gsv-restart-note');
    restartNote.hidden = true;
    const restartBtn = ui.button(t.restart, {
      size: 'sm',
      onClick: () => {
        if (restartBtn.disabled) return;
        restartBtn.disabled = true;
        restartLock = Date.now();
        void call('restart');
      },
    });
    restartBar.append(restartNote, restartBtn);
    const output = ui.h('pre', 'gsv-output');
    status.append(output);

    // ---- 已安装模型：手动统计（不跟每秒轮询），卸载前弹确认
    const models = ui.section(t.models, t.modelsHint);
    const modelList = ui.h('div');
    const modelFoot = ui.actions();
    const modelTotal = ui.h('span', 'gsv-detail', t.modelsScan);
    modelFoot.append(ui.button(t.modelsRefresh, { size: 'sm', onClick: () => void loadUsage(true) }), modelTotal);
    models.append(modelList, modelFoot);

    const labelOf = (item: UsageItem) => (item.kind === 'weights' ? t.weightsBase
      : item.kind === 'partial' ? t.runtimePartial
        : item.kind === 'stale' ? t.runtimeStale
          : item.id === 'cuda' ? t.runtimeCuda
            : item.id === 'rocm' ? t.runtimeRocm : t.runtimeCpu);

    const itemSize = (item: UsageItem) => `${item.estimated ? '≈' : ''}${sizeText(item.bytes)}`;

    const renderUsage = (u: UsageState) => {
      modelList.replaceChildren();
      const approx = u.items.some((item) => item.estimated) ? '≈' : '';
      modelTotal.textContent = u.items.length ? t.modelsCleanable(`${approx}${sizeText(u.total)}`) : t.modelsEmpty;
      for (const item of u.items) {
        const r = row(labelOf(item), modelList);
        const shared = item.kind === 'runtime';
        setPill(r.pill, shared ? t.sharedRuntime : t.ready, shared ? 'warn' : 'on');
        r.detail.textContent = item.dir;
        r.acts.append(
          ui.h('span', 'gsv-detail', itemSize(item)),
          ui.button(t.uninstall, { size: 'sm', onClick: () => void removeModel(item) }),
        );
      }
    };

    const loadUsage = async (refresh = false) => {
      modelTotal.textContent = t.modelsScan;
      try { renderUsage(await ctx.invoke<UsageState>('usage', refresh ? ['refresh'] : [])); }
      catch (err) { modelTotal.textContent = errText(err); }
    };

    const removeModel = async (item: UsageItem) => {
      const name = labelOf(item);
      if (!(await ui.confirm({ title: t.uninstall, body: t.uninstallConfirm(name, `${item.estimated ? '≈' : ''}${sizeText(item.bytes)}`) }))) return;
      try {
        const res = await ctx.invoke<{ usage: UsageState; removed: { id: string; bytes: number } }>('uninstall', [item.id]);
        msg.textContent = t.uninstalled(name, sizeText(res.removed.bytes));
        msg.classList.remove('bad');
        renderUsage(res.usage);
        void refresh();
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

    // ---- 试听
    const test = ui.section(t.test);
    const line = ui.input({});
    line.value = t.testText;
    const testActs = ui.actions();
    testActs.append(
      ui.button(t.test, { variant: 'primary', size: 'sm', onClick: () => void call('test', [line.value]) }),
      ui.button(t.hush, { size: 'sm', onClick: () => void call('hush') }),
    );
    const said = ui.h('span', 'gsv-detail');
    const queue = ui.h('span', 'gsv-detail');
    test.append(line, testActs, said, queue);

    // 未选引擎时整组本地设置隐藏；msg 留在外面，引擎相关的报错仍能看到。
    const localBox = ui.h('div');
    localBox.append(status, models, test);
    ctx.root.append(engineSec, localBox, restartBar, msg);

    const setPill = (el: HTMLElement, label: string, tone: 'on' | 'off' | 'warn' | 'bad') => {
      el.textContent = label;
      el.dataset.tone = tone;
    };

    function render(s: PanelState) {
      state = s;
      // 引擎：未选择时只留顶部提示；选好后只显示所选引擎的设置。
      engineSel.value = s.engine ?? '';
      engineUnset.hidden = s.engine !== null;
      localBox.hidden = s.engine !== 'local';
      engineCloudNote.hidden = s.engine !== 'cloud';
      if (s.engine === 'cloud') engineCloudNote.textContent = `${cloudSummary(s, t)} · ${t.engineCloudWhere}`;
      const bad = s.engine === 'cloud' ? null : s.mismatch;
      engineMismatch.hidden = !bad;
      if (bad) engineMismatch.textContent = t.modelMismatch(modelLabel(bad.want), modelLabel(bad.current));
      // 推理档
      setPill(tierRow.pill, s.tier === 'cuda' ? t.tierCuda : s.tier === 'rocm' ? t.tierRocm : t.tierCpu, 'on');
      // 自动档说明实际选了哪一档；显式选了显卡档但机器不支持时提前警告，别等下了几个 GB 运行时才失败。
      // macOS 没有可下载的运行时包：直接说明要走自备运行时，别落到「没有检测到独立显卡」那种说法上。
      const explain = s.platform !== 'win32'
        ? (s.tier === 'cuda' ? t.tierCudaMissing(s.gpu)
          : s.tier === 'rocm' ? t.tierRocmMissing(null)
            : t.tierMac)
        : s.tierSetting === 'auto'
          ? (s.cudaFound ? t.tierAuto(true)
            : s.amd.kind === 'supported'
              ? (s.tier === 'rocm' ? t.tierAutoRocm(s.amd.gpu.gfx) : t.tierRocmUnpublished(s.amd.gpu.gfx))
              : s.gpu === 'amd'
                ? (s.amd.kind === 'unsupported' && s.amd.integrated ? t.tierNoDiscrete : t.tierAmdUnsupported(s.amd.kind === 'unsupported' ? s.amd.name : ''))
                : t.tierAuto(false))
          : s.tier === 'cuda' && !s.cudaFound ? t.tierCudaMissing(s.gpu)
            : s.tier === 'rocm' && s.amd.kind !== 'supported' ? t.tierRocmMissing(s.amd.kind === 'unsupported' ? s.amd.name : null)
              : '';
      tierRow.detail.textContent = [explain, t.modelLine(s.version === 'v5turbo' ? 'V5 turbo' : 'V2 Pro Plus')].filter(Boolean).join(' · ');
      // 运行时与权重
      const managed = s.backend === 'managed';
      runtimeRow.acts.hidden = !managed;
      if (s.backend === 'remote') { setPill(runtimeRow.pill, t.remote, 'on'); runtimeRow.detail.textContent = s.runtime.dir; }
      else if (s.backend === 'own') { setPill(runtimeRow.pill, s.runtime.own ? t.ownRuntime : t.error, s.runtime.own ? 'on' : 'bad'); runtimeRow.detail.textContent = s.runtime.dir; }
      else jobRow(runtimeRow, s.runtime, s.runtime.published ? null : t.unpublished);
      weightsRow.pill.parentElement!.hidden = !managed;
      if (managed) jobRow(weightsRow, s.weights, null);
      // 权重来源：自备 / 内置，填错了在这里能直接看到原因
      if (s.trained.problem) {
        setPill(trainedRow.pill, t.error, 'bad');
        trainedRow.detail.textContent = s.trained.problem;
      } else if (s.trained.weights) {
        setPill(trainedRow.pill, s.trained.official ? t.trainedOfficial : t.trainedOwn, 'on');
        trainedRow.detail.textContent = `${baseName(s.trained.weights.gpt)} + ${baseName(s.trained.weights.sovits)}`;
      } else {
        setPill(trainedRow.pill, t.trainedBuiltin, 'on');
        trainedRow.detail.textContent = t.trainedHint;
      }
      const toDownload = (s.runtime.phase === 'ready' ? 0 : s.runtime.bytes) + (s.weights.phase === 'ready' ? 0 : s.weights.bytes);
      installBtn.textContent = toDownload ? t.installSize(MB(toDownload)) : t.install;
      const busy = s.runtime.phase === 'working' || s.weights.phase === 'working';
      installBtn.disabled = busy || !s.runtime.published || (s.runtime.phase === 'ready' && s.weights.phase === 'ready' && s.server.phase !== 'stopped' && s.server.phase !== 'error');
      cancelBtn.hidden = !busy;
      // 推理服务
      serverRow.pill.parentElement!.hidden = s.backend === 'remote';
      const sv = s.server;
      if (sv.phase === 'ready' && sv.warmed) setPill(serverRow.pill, t.running, 'on');
      else if (sv.phase === 'starting' || sv.warming) setPill(serverRow.pill, sv.warming ? t.warming : t.starting, 'warn');
      else if (sv.phase === 'error') setPill(serverRow.pill, t.error, 'bad');
      else setPill(serverRow.pill, t.stopped, 'off');
      serverRow.detail.textContent = sv.phase === 'ready' && sv.startMs ? t.startMs(Math.round(sv.startMs / 1000)) : sv.detail ?? '';
      startBtn.hidden = sv.phase !== 'stopped' && sv.phase !== 'error';
      stopBtn.hidden = sv.phase === 'stopped';
      // 页脚条：只在本地引擎运行/异常时出现；启动中/预热中保持禁用并给出文案。
      const starting = sv.phase === 'starting' || sv.warming;
      if (restartLock && Date.now() - restartLock > 1500 && !starting) restartLock = 0;
      restartBar.hidden = s.engine !== 'local' || s.backend === 'remote' || sv.phase === 'stopped';
      restartBtn.disabled = !!restartLock || starting;
      restartNote.hidden = !starting && sv.phase !== 'error';
      restartNote.textContent = starting
        ? (sv.warming ? t.warming : t.starting)
        : sv.phase === 'error' ? `${t.error}: ${sv.detail ?? ''}` : '';
      restartNote.classList.toggle('is-bad', !starting && sv.phase === 'error');
      output.textContent = sv.phase === 'error' || sv.phase === 'starting' ? s.output.join('\n') : '';
      output.hidden = !output.textContent;
      // 队列与上次错误（音色在配置页管理，这里只显示状态）
      const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
      said.textContent = s.lastSpoken ? t.lastSpoken(s.lastSpoken.translated, clip(s.lastSpoken.text)) : '';
      queue.textContent = [s.queue ? t.queue(s.queue) : '', s.lastError ? `${t.lastError}:${s.lastError}` : ''].filter(Boolean).join(' · ');
    }

    function jobRow(r: ReturnType<typeof row>, job: PanelState['runtime'] | PanelState['weights'], note: string | null) {
      if (job.phase === 'ready') setPill(r.pill, t.ready, 'on');
      else if (job.phase === 'working') setPill(r.pill, `${t.working} ${pct(job.done, job.total)}`, 'warn');
      else if (job.phase === 'error') setPill(r.pill, t.error, 'bad');
      else setPill(r.pill, t.absent, 'off');
      r.detail.textContent = job.phase === 'error' ? job.detail ?? '' : job.phase === 'working' ? job.detail ?? '' : note ?? job.dir;
    }

    const refresh = async () => {
      try { render(await ctx.invoke<PanelState>('state')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    void loadUsage();
    ctx.interval(() => void refresh(), 1000);
  },
};

/**
 * 「音色」面板：L0 引擎（本地 / 云端）；L1 按引擎显示一组音色——
 * 本地是预设 + 自定义音色，云端是云端音色清单与连接参数（含密钥输入框）。
 * 保存/删除立即生效并刷新；密钥只回显掩码，留空或提交掩码都表示不修改。
 */
const voicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let editingId: string | null = null;
    let primed = false;
    let voiceSig = '';

    // 返回是否成功：失败时保留表单与错误提示，别让用户以为「点了没反应」。
    const call = async (method: string, args: unknown[] = []): Promise<boolean> => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const next = await ctx.invoke<PanelState>(method, args);
        if (!next || !('backend' in next)) return false;
        render(next);
        if (next.notice) {
          const { text, bad } = noticeText(next.notice, t);
          msg.textContent = text;
          msg.classList.toggle('bad', bad);
          ui.toast(text);
        }
        return true;
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        return false;
      }
    };

    // ---- 引擎选择已移到「语音」页顶部；这里只在没选引擎时给一条提示
    const unsetNote = ui.h('div', 'gsv-detail', t.engineUnsetVoices);
    // 推理模型与当前音色权重的版本冲突：保存不再拦，但这里要看得见。
    const mismatchNote = ui.h('div', 'gsv-detail');

    // 旧宿主没有 foldSheet 时退回普通卡，不白屏。
    const foldSheet = (ui as unknown as {
      foldSheet?: (id: string, opts: { title: string; desc?: string; defaultOpen?: boolean }) => WebUiSheet;
    }).foldSheet;
    const card = (id: string, title: string, desc: string): WebUiSheet => {
      if (typeof foldSheet === 'function') return foldSheet.call(ui, id, { title, desc, defaultOpen: true });
      return ui.sheet({ title, desc });
    };

    // ---- 台词与翻译：原「音色与台词」页搬过来的字段，选项与写盘行为保持一致
    const speechCard = card('voices-speech', t.speechTitle, t.speechHint);
    void (async () => {
      try {
        const resp = await ctx.invoke<ConfigResp>('config', ['world:gpt-sovits', '', false]);
        const moved = ['textLang', 'translateEndpoint', 'translateApiKeySecret', 'translateModel', 'speed', 'seed', 'promptLanguage'];
        speechCard.body.replaceChildren();
        for (const f of resp.properties.filter((item) => moved.some((name) => item.key.endsWith(`.${name}`)))) {
          mountConfigField(ctx, speechCard.body, f, resp.values[f.key]);
        }
      } catch (err) {
        speechCard.body.replaceChildren(ui.h('div', 'gsv-detail', errText(err)));
      }
    })();

    // ---- L1 本地：预设音色 + 自定义音色
    const localCard = card('voices-local', t.localGroup, t.localGroupDesc);
    localCard.body.append(ui.h('div', 'gsv-detail', t.preset));
    const presetList = ui.h('div');
    const presetPills = new Map<string, HTMLElement>();
    for (const id of VOICE_PRESETS) {
      const line = ui.h('div', 'gsv-row');
      const pill = ui.h('span', 'gsv-pill');
      const acts = ui.h('span', 'gsv-acts');
      acts.append(ui.button(t.use, { size: 'sm', onClick: () => void call('use', [id]) }));
      line.append(ui.h('span', 'gsv-name', presetLabel(id, ctx.language)), pill, ui.h('span', 'gsv-detail', presetFileLabel(id)), acts);
      presetList.append(line);
      presetPills.set(id, pill);
    }
    localCard.body.append(presetList);

    const sec = ui.h('div');
    const list = ui.h('div');
    const addBtn = ui.button(t.addVoice, { variant: 'primary', size: 'sm', onClick: () => openForm(null) });
    const form = ui.h('div');
    form.hidden = true;
    const fName = ui.input({ placeholder: t.voiceNamePh });
    const fAudio = ui.input({});
    fAudio.type = 'file';
    fAudio.accept = '.wav,audio/wav';
    const fText = ui.textarea({});
    fText.rows = 2;
    const fGpt = ui.input({ placeholder: t.gptWeightOpt });
    const fSov = ui.input({ placeholder: t.sovitsWeightOpt });
    const saveBtn = ui.button(t.saveVoice, { variant: 'primary', size: 'sm', onClick: () => void save() });
    const cancelBtn = ui.button(t.cancelAdd, { size: 'sm', onClick: () => closeForm() });
    const formActs = ui.actions();
    formActs.append(saveBtn, cancelBtn);
    form.append(
      ui.h('div', 'gsv-detail', t.requiredHint),
      ui.field(t.voiceName, fName),
      ui.field(t.voiceAudio, fAudio),
      ui.field(t.voiceTextRequired, fText),
      ui.field(t.gptWeightOpt, fGpt),
      ui.field(t.sovitsWeightOpt, fSov),
      formActs,
    );
    sec.append(ui.h('div', 'gsv-detail', `${t.customVoices} · ${t.customVoicesHint}`), list, addBtn, form);
    localCard.body.append(sec);

    function openForm(v: PanelState['voices'][number] | null): void {
      editingId = v?.id ?? null;
      fName.value = v?.name ?? '';
      fAudio.value = '';
      fText.value = v?.text ?? '';
      fGpt.value = v?.weights.gpt ?? '';
      fSov.value = v?.weights.sovits ?? '';
      saveBtn.textContent = v ? t.saveVoice : t.confirmAdd;
      form.hidden = false;
      addBtn.hidden = true;
      msg.textContent = t.requiredHint;
      msg.classList.remove('bad');
    }

    function closeForm(): void {
      editingId = null;
      form.hidden = true;
      addBtn.hidden = false;
      fAudio.value = '';
      msg.textContent = '';
    }

    async function save(): Promise<void> {
      const f = fAudio.files?.[0];
      const pairOk = !!fGpt.value.trim() === !!fSov.value.trim();
      // 参考音频与台本必填，权重成对或都不填；缺了就地提示，不发请求。
      if ((!f && !editingId) || !fText.value.trim() || !pairOk) {
        msg.textContent = t.incomplete;
        msg.classList.add('bad');
        return;
      }
      let b64 = '';
      if (f) {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        b64 = btoa(bin);
      }
      if (editingId) { if (await call('update', [editingId, fName.value, b64, fText.value, fGpt.value.trim(), fSov.value.trim()])) closeForm(); }
      else if (await call('add', [fName.value, f!.name, b64, fText.value, fGpt.value.trim(), fSov.value.trim()])) closeForm();
    }

    // ---- L1 云端：连接参数、密钥、音色清单
    const cloudCard = card('voices-cloud', t.cloudGroup, t.cloudGroupDesc);
    const cloudStatus = ui.h('div', 'gsv-detail');
    const autoVoicesNote = ui.h('div', 'gsv-detail');
    const cloudPresetNote = ui.h('div', 'gsv-detail gsv-warn');
    const cloudErrorNote = ui.h('div', 'gsv-detail gsv-bad');
    const cloudFields = ui.h('div', 'gsv-cfg');
    cloudFields.style.display = 'grid';
    cloudFields.style.gridTemplateColumns = 'repeat(2, minmax(9em, 1fr))';
    cloudFields.style.gap = '.6em';
    const fBase = ui.input({ placeholder: 'https://api.openai.com/v1', onChange: (v) => void call('setCloudField', ['cloudBaseUrl', v]) });
    const fModel = ui.input({ placeholder: 'tts-1', onChange: (v) => void call('setCloudField', ['cloudModel', v]) });
    const fVoice = ui.select({ onChange: (v) => void call('setCloudField', ['cloudVoiceId', v]) });
    const fTimeout = ui.input({ type: 'number', onChange: (v) => void call('setCloudField', ['cloudTimeoutMs', Number(v)]) });
    fTimeout.min = '5000';
    fTimeout.max = '300000';
    fTimeout.step = '1000';
    // 每个字段下带一行小字：必填的说明格式，可不填的说明默认值与留空行为。
    const withHint = (label: string, control: HTMLElement, hint: string): HTMLElement => {
      const box = ui.h('div');
      box.append(ui.field(label, control), ui.h('div', 'gsv-detail', hint));
      return box;
    };
    cloudFields.append(
      withHint(t.cloudBase, fBase, t.cloudBaseHint),
      withHint(t.cloudModel, fModel, t.cloudModelHint),
      withHint(t.cloudVoice, fVoice, t.cloudVoiceHint),
      withHint(t.cloudTimeout, fTimeout, t.cloudTimeoutHint),
    );

    const keyInput = ui.input({ type: 'password', placeholder: t.cloudKeyPh });
    const keySave = ui.button(t.cloudKeySave, { variant: 'primary', size: 'sm', onClick: () => void saveKey() });
    const keyClear = ui.button(t.cloudKeyClear, { size: 'sm', onClick: () => void clearKey() });
    const keyActs = ui.actions();
    keyActs.append(keySave, keyClear);
    const keyNote = ui.h('span', 'gsv-detail');
    const keyBox = ui.h('div', 'gsv-cfg');
    keyBox.append(ui.field(t.cloudKey, keyInput), ui.h('div', 'gsv-detail', t.cloudKeyRequired), keyActs, keyNote, ui.h('div', 'gsv-detail', t.cloudKeyHint));

    const cloudList = ui.h('div');
    const cloudName = ui.input({ placeholder: t.cloudVoiceNamePh });
    const cloudId = ui.input({ placeholder: t.cloudVoiceIdPh });
    const cloudAdd = ui.button(t.cloudVoiceAdd, { size: 'sm', onClick: () => void addCloudVoice() });
    const cloudRefresh = ui.button(t.cloudVoicesRefresh, { size: 'sm', onClick: () => void call('refreshCloudVoices') });
    const cloudAddFields = ui.h('div', 'gsv-cfg');
    cloudAddFields.style.display = 'grid';
    cloudAddFields.style.gridTemplateColumns = 'repeat(2, minmax(9em, 1fr))';
    cloudAddFields.style.gap = '.6em';
    cloudAddFields.append(ui.field(t.cloudVoiceName, cloudName), ui.field(t.cloudVoiceId, cloudId));
    const cloudAddActs = ui.actions();
    cloudAddActs.append(cloudAdd, cloudRefresh);

    cloudCard.body.append(
      cloudStatus,
      autoVoicesNote,
      cloudPresetNote,
      cloudErrorNote,
      cloudFields,
      keyBox,
      ui.h('div', 'gsv-detail', `${t.cloudVoicesList} · ${t.cloudWavOnly}`),
      cloudList,
      cloudAddFields,
      ui.h('div', 'gsv-detail', t.cloudAddHint),
      cloudAddActs,
    );

    async function saveKey(): Promise<void> {
      const value = keyInput.value.trim();
      const current = state?.cloud.keyMask ?? '';
      // 留空或把掩码原样提交：都当作「不修改」，避免把展示用的掩码存成真密钥。
      if (!value || value === current) {
        msg.textContent = t.cloudKeyUnchanged;
        msg.classList.remove('bad');
        return;
      }
      if (await call('saveCloudKey', [value])) {
        keyInput.value = '';
        msg.textContent = t.cloudKeySaved(state?.cloud.keyMask ?? '');
      }
    }

    async function clearKey(): Promise<void> {
      if (!(await ui.confirm({ title: t.cloudKeyClear, body: t.cloudKeyClearConfirm }))) return;
      if (await call('clearCloudKey')) msg.textContent = t.cloudKeyCleared;
    }

    async function addCloudVoice(): Promise<void> {
      const id = cloudId.value.trim();
      if (!id) {
        msg.textContent = t.cloudVoiceIdRequired;
        msg.classList.add('bad');
        return;
      }
      const voices = state?.cloud.voices ?? [];
      if (voices.some((v) => v.id === id)) {
        msg.textContent = t.cloudVoiceExists(id);
        msg.classList.add('bad');
        return;
      }
      if (await call('setCloudVoices', [[...voices, { id, name: cloudName.value.trim() || id }]])) {
        cloudName.value = '';
        cloudId.value = '';
      }
    }

    const setPill = (el: HTMLElement, label: string, tone: 'on' | 'off' | 'bad'): void => {
      el.textContent = label;
      el.dataset.tone = tone;
    };

    function renderList(s: PanelState): void {
      list.textContent = '';
      if (!s.voices.length) { list.append(ui.h('div', 'gsv-detail', t.noVoice)); return; }
      for (const v of s.voices) {
        const line = ui.h('div', 'gsv-row');
        const name = ui.h('span', 'gsv-name', v.name);
        const pill = ui.h('span', 'gsv-pill');
        const detail = ui.h('span', 'gsv-detail', `${v.audio ? baseName(v.audio) : t.noVoice} · ${v.text.slice(0, 24) || t.voiceText}${v.weights.gpt ? ` · ${t.trainedOwn}` : ''}`);
        const acts = ui.h('span', 'gsv-acts');
        line.append(name, pill, detail, acts);
        list.append(line);
        setPill(pill, v.selected ? t.using : '', v.selected ? 'on' : 'off');
        if (!v.selected) acts.append(ui.button(t.use, { size: 'sm', onClick: () => void call('use', [v.id]) }));
        acts.append(
          ui.button(t.edit, { size: 'sm', onClick: () => openForm(v) }),
          ui.button(t.remove, { size: 'sm', onClick: () => void call('remove', [v.id]) }),
        );
      }
    }

    function renderCloud(s: PanelState): void {
      const c = s.cloud;
      // 没选引擎时两张卡都不显示，只留提示。
      unsetNote.hidden = s.engine !== null;
      localCard.el.hidden = s.engine !== 'local';
      cloudCard.el.hidden = s.engine !== 'cloud';
      // 台词设置对本地和云端都生效，选了引擎才显示；云端模式下本地权重不参与合成，冲突提示不必露出来。
      speechCard.el.hidden = s.engine === null;
      const bad = s.engine === 'cloud' ? null : s.mismatch;
      mismatchNote.hidden = !bad;
      if (bad) mismatchNote.textContent = t.modelMismatch(modelLabel(bad.want), modelLabel(bad.current));
      const summary = cloudSummary(s, t);
      const presetId = s.voice?.preset;
      localCard.note.textContent = presetId
        ? (isPreset(presetId) ? presetLabel(presetId, ctx.language) : (s.voices.find((v) => v.id === presetId)?.name ?? ''))
        : '';
      cloudCard.note.textContent = summary;
      cloudStatus.textContent = `${t.cloudStatus} · ${summary}`;
      // 默认清单是算出来的、不写盘；告诉用户这是为了「只填密钥就能用」，不是他手动配的。
      autoVoicesNote.hidden = !c.autoVoices;
      if (c.autoVoices) autoVoicesNote.textContent = t.cloudVoicesAuto;
      // 接口不是 OpenAI、却选了 OpenAI 官方音色：合成前就说清楚，别等厂商报错才发现。
      cloudPresetNote.hidden = !c.presetMismatch;
      if (c.presetMismatch) cloudPresetNote.textContent = t.cloudPresetNote(c.voiceId);
      // 上一次云端失败（例如厂商不认这个音色）也挂在卡片上；改了地址/模型/音色会自动清掉。
      cloudErrorNote.hidden = !s.lastError;
      if (s.lastError) cloudErrorNote.textContent = t.cloudLastError(s.lastError);
      // 首次拿到状态才填输入框，之后别每秒覆盖用户正在输入的值。
      if (!primed) {
        primed = true;
        fBase.value = c.baseUrl;
        fModel.value = c.model;
        fTimeout.value = String(c.timeoutMs);
      }
      const sig = c.voices.map((v) => `${v.id}\u0000${v.name}\u0000${v.official ? 1 : 0}`).join('\u0001');
      if (sig !== voiceSig) {
        voiceSig = sig;
        fVoice.replaceChildren();
        if (c.voices.length) {
          for (const v of c.voices) {
            const option = ui.h('option', null, `${v.name && v.name !== v.id ? `${v.name} · ${v.id}` : v.id}${v.official ? t.cloudOfficialTag : ''}`);
            option.value = v.id;
            fVoice.append(option);
          }
        } else {
          const option = ui.h('option', null, t.cloudVoiceNone);
          option.value = '';
          fVoice.append(option);
        }
      }
      const current = c.voices.some((v) => v.id === c.voiceId) ? c.voiceId : (c.voices[0]?.id ?? '');
      if (document.activeElement !== fVoice) fVoice.value = current;
      keyInput.placeholder = c.keyMask ? t.cloudKeyPhSet(c.keyMask) : t.cloudKeyPh;
      keyNote.textContent = c.keySet
        ? (c.keyMask ? t.cloudKeyMaskNote(c.keyMask) : t.cloudKeyUnreadable)
        : t.cloudKeyUnset;
      keyClear.disabled = !c.keySet;
      cloudList.replaceChildren();
      if (!c.voices.length) cloudList.append(ui.h('div', 'gsv-detail', t.cloudVoicesEmpty));
      for (const v of c.voices) {
        const line = ui.h('div', 'gsv-row');
        const pill = ui.h('span', 'gsv-pill');
        const acts = ui.h('span', 'gsv-acts');
        line.append(
          ui.h('span', 'gsv-name', `${v.name || v.id}${v.official ? t.cloudOfficialTag : ''}`),
          pill,
          ui.h('span', 'gsv-detail', v.name && v.name !== v.id ? v.id : ''),
          acts,
        );
        cloudList.append(line);
        const selected = v.id === c.voiceId;
        setPill(pill, selected ? t.using : '', selected ? 'on' : 'off');
        if (!selected) acts.append(ui.button(t.use, { size: 'sm', onClick: () => void call('setCloudField', ['cloudVoiceId', v.id]) }));
        acts.append(ui.button(t.remove, { size: 'sm', onClick: () => void call('setCloudVoices', [c.voices.filter((item) => item.id !== v.id)]) }));
      }
      for (const [id, pill] of presetPills) setPill(pill, s.voice?.preset === id ? t.using : '', s.voice?.preset === id ? 'on' : 'off');
    }

    function render(s: PanelState): void {
      state = s;
      renderList(s);
      renderCloud(s);
    }

    const refresh = async () => {
      try { render(await ctx.invoke<PanelState>('state')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 1000);

    ctx.root.append(mismatchNote, unsetNote, localCard.el, cloudCard.el, speechCard.el, msg);
  },
};

/**
 * 「训练」面板：训练依赖、训练资源、训练 WebUI 三行状态，以及启动/停止与日志折叠。
 * 训练 WebUI 是运行时里的上游 `webui.py`，启动要读模型，慢；这里每 2 秒轮询一次状态。
 */
const trainPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: TrainerState | null = null;
    let expanded = false;

    const call = async (method: string, args: unknown[] = []) => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        render(await ctx.invoke<TrainerState>(method, args));
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

    // ---- 状态三行
    const status = ui.section(t.trainPanel, t.trainPanelHint);
    const row = (name: string) => {
      const el = ui.h('div', 'gsv-row');
      const label = ui.h('span', 'gsv-name', name);
      const pill = ui.h('span', 'gsv-pill');
      const detail = ui.h('span', 'gsv-detail');
      const acts = ui.h('span', 'gsv-acts');
      el.append(label, pill, detail, acts);
      status.append(el);
      return { pill, detail, acts };
    };
    const depsRow = row(t.trainDeps), assetsRow = row(t.trainAssets), serverRow = row(t.trainServer);

    const installBtn = ui.button(t.trainInstallDeps, { size: 'sm', onClick: () => void call('installTrainer') });
    depsRow.acts.append(installBtn);
    const downloadBtn = ui.button(t.trainDownloadAssets, { size: 'sm', onClick: () => void call('downloadTrainerAssets') });
    assetsRow.acts.append(downloadBtn);
    const stopFirst = ui.checkbox(t.trainStopFirst, { checked: true });
    const startBtn = ui.button(t.trainStart, { variant: 'primary', size: 'sm', onClick: () => void call('startTrainer', [stopFirst.checked]) });
    const stopBtn = ui.button(t.stop, { size: 'sm', onClick: () => void call('stopTrainer') });
    const openBtn = ui.button(t.trainOpen, { size: 'sm', onClick: () => { const url = state?.url; if (url) window.open(url, '_blank', 'noopener'); } });
    serverRow.acts.append(stopFirst.el, startBtn, stopBtn, openBtn);

    // 首帧状态到位前先禁用/藏起，避免在未知状态上误点；首次成功 render 即解锁。
    installBtn.disabled = downloadBtn.disabled = openBtn.disabled = true;
    startBtn.hidden = stopBtn.hidden = stopFirst.el.hidden = true;

    status.append(ui.msgline(t.trainWarn, true));
    status.append(ui.h('div', 'gsv-detail', t.trainArtifactsTip));
    const logLabel = ui.h('div', 'gsv-detail', t.trainLog);
    logLabel.hidden = true;
    const log = ui.h('pre', 'gsv-output');
    log.hidden = true;
    const logToggle = ui.button(t.trainLogToggle, {
      size: 'sm',
      onClick: () => {
        expanded = !expanded;
        logLabel.hidden = log.hidden = !expanded;
        if (expanded && state) log.textContent = state.logTail.join('\n');
      },
    });
    const logActs = ui.actions();
    logActs.append(logToggle);
    status.append(logActs, logLabel, log);

    const setPill = (el: HTMLElement, label: string, tone: 'on' | 'off' | 'warn') => {
      el.textContent = label;
      el.dataset.tone = tone;
    };

    function render(s: TrainerState): void {
      state = s;
      // 训练依赖
      if (s.deps === 'ready') setPill(depsRow.pill, t.trainDepsReady, 'on');
      else if (s.deps === 'installing') setPill(depsRow.pill, t.trainDepsInstalling, 'warn');
      else setPill(depsRow.pill, t.trainDepsMissing, 'off');
      depsRow.detail.textContent = s.depsError ?? '';
      installBtn.disabled = s.deps === 'installing';
      // 训练资源：就位几个/共几个 + 还缺多少 MB（失败原因一并显示）
      const have = s.assets.filter((a) => a.ready).length;
      const pendingBytes = s.assets.reduce((sum, a) => (a.ready ? sum : sum + a.bytes), 0);
      const parts = [t.trainAssetsCount(have, s.assets.length)];
      if (pendingBytes) parts.push(`${MB(pendingBytes)} MB`);
      if (s.assetsError) parts.push(s.assetsError);
      setPill(assetsRow.pill, s.assetsReady ? t.ready : t.absent, s.assetsReady ? 'on' : 'off');
      assetsRow.detail.textContent = parts.join(' · ');
      downloadBtn.disabled = s.assetsWorking;
      // 训练 WebUI
      if (s.running && !s.starting) setPill(serverRow.pill, t.running, 'on');
      else if (s.starting) setPill(serverRow.pill, t.starting, 'warn');
      else setPill(serverRow.pill, t.stopped, 'off');
      serverRow.detail.textContent = s.url ?? '';
      startBtn.hidden = stopFirst.el.hidden = s.running || s.starting;
      stopBtn.hidden = !(s.running || s.starting);
      openBtn.disabled = !s.url;
      // 日志：展开时才把尾部刷进去
      if (expanded) log.textContent = s.logTail.join('\n');
    }

    const refresh = async () => {
      try { render(await ctx.invoke<TrainerState>('trainerState')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 2000);

    ctx.root.append(status, msg);
  },
};

type ConfigField = {
  key: string;
  type: string;
  title: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  path?: { kind?: 'file' | 'directory'; extensions?: string[] };
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  xHot: boolean;
};
type ConfigResp = { groupId: string; title?: string; description?: string; properties: ConfigField[]; values: Record<string, unknown> };
type QqGuide = {
  installed: boolean;
  httpApi: boolean;
  port: number;
  voice: string;
  tokenSet: boolean;
  path: string;
  values: Array<{ label: string; value: string }>;
  current: { enabled: boolean; provider: string; tts: boolean; voiceBaseUrl: string; voiceVoice: string } | null;
};

/** 「与其他插件联动」页底部的 QQ 对接说明：展示要填的值 + 一键写入。 */
async function mountQqGuide(ctx: WebUiPanelContext, host: HTMLElement, onChanged?: () => void): Promise<void> {
  const { ui } = ctx;
  const t = panelText(ctx.language);
  const sec = ui.section(t.qqTitle, t.qqHint);
  const status = ui.h('div', 'gsv-detail');
  const steps = ui.h('div', 'gsv-cfg');
  steps.append(
    ui.h('div', 'gsv-detail', `1. ${t.qqStep1}`),
    ui.h('div', 'gsv-detail', `2. ${t.qqStep2}`),
    ui.h('div', 'gsv-detail', `3. ${t.qqStep3}`),
  );
  const code = ui.h('pre', 'gsv-output');
  const acts = ui.actions();
  const msg = ui.msgline();
  let guide: QqGuide | null = null;
  const codeText = () => (guide ? guide.values.map((v) => `${v.label} = ${v.value}`).join('\n') : '');
  const copyAll = ui.copyButton(() => codeText(), { label: t.qqCopyAll, size: 'sm' });
  const write = ui.button(t.qqWrite, {
    variant: 'primary',
    size: 'sm',
    onClick: () => {
      void (async () => {
        if (!(await ui.confirm({ title: t.qqWrite, body: t.qqConfirm }))) return;
        msg.classList.remove('bad');
        msg.textContent = '';
        try {
          const res = await ctx.invoke<{ ok: boolean; path: string; backup: string }>('writeQqVoice');
          ui.toast(t.qqWriteOk);
          msg.textContent = `${t.qqWriteOk}（${res.path}）`;
          await load();
          onChanged?.();
        } catch (err) {
          msg.textContent = errText(err);
          msg.classList.add('bad');
        }
      })();
    },
  });
  acts.append(copyAll, write);
  sec.append(status, steps, code, acts, msg);
  host.append(sec);

  const load = async () => {
    try {
      guide = await ctx.invoke<QqGuide>('qqGuide');
      status.textContent = [
        guide.installed ? t.qqInstalled : t.qqMissing,
        guide.httpApi ? t.qqApiOn : t.qqApiOff,
        guide.tokenSet ? t.qqTokenWarn : '',
        guide.current ? `${t.qqCurrent}：${guide.current.provider || '—'} · ${guide.current.voiceBaseUrl || '—'} · ${guide.current.voiceVoice || '—'}` : '',
      ].filter(Boolean).join(' · ');
      code.textContent = guide.values.map((v) => `${v.label}：${v.value}`).join('\n');
      write.disabled = !guide.installed;
    } catch (err) {
      status.textContent = errText(err);
    }
  };
  await load();
}

/**
 * 「出口变声（RVC）」子卡：检测 / 端点 / 超时 / 变调 / 索引率 / 一键写入 / 试听。
 * 检测只读对方 `/health`；一键写入把卡片上的值一次写进 `worlds.gpt-sovits.rvc`；
 * 试听走 `rvcTest`：整条「合成 → RVC → WAV」都真跑，但只在浏览器里播放。
 */
async function mountRvcCard(ctx: WebUiPanelContext, host: HTMLElement, values: Record<string, unknown>, onWrite?: (next: { enabled: boolean; endpoint: string }) => void): Promise<void> {
  const { ui } = ctx;
  const t = panelText(ctx.language);
  const msg = ui.msgline();
  const status = ui.h('div', 'gsv-detail');
  const read = (key: string, fallback: string): string => {
    const v = values[`worlds.gpt-sovits.rvc.${key}`];
    return v == null || v === '' ? fallback : String(v);
  };
  const enabled = ui.checkbox(t.rvcEnabled, { checked: values['worlds.gpt-sovits.rvc.enabled'] === true });
  const endpoint = ui.input({ value: read('endpoint', 'http://127.0.0.1:9881') });
  const timeout = ui.input({ type: 'number', value: read('timeoutMs', '8000') });
  timeout.min = '500';
  timeout.max = '60000';
  timeout.step = '100';
  const pitch = ui.input({ type: 'number', value: read('pitch', '0') });
  pitch.min = '-24';
  pitch.max = '24';
  pitch.step = '1';
  const indexRate = ui.input({ type: 'number', value: read('indexRate', '0.3') });
  indexRate.min = '0';
  indexRate.max = '1';
  indexRate.step = '0.05';

  const knobs = ui.h('div', 'gsv-cfg');
  knobs.style.display = 'grid';
  knobs.style.gridTemplateColumns = 'repeat(3, minmax(7em, 1fr))';
  knobs.style.gap = '.6em';
  knobs.append(ui.field(t.rvcTimeout, timeout), ui.field(t.rvcPitch, pitch), ui.field(t.rvcIndexRate, indexRate));
  const endpointField = ui.h('div', 'gsv-cfg');
  endpointField.append(ui.field(t.rvcEndpoint, endpoint));

  const audio = ui.h('audio');
  audio.controls = true;
  audio.hidden = true;
  let url: string | null = null;
  ctx.own({ dispose: () => { if (url) URL.revokeObjectURL(url); } });

  const probeBtn = ui.button(t.rvcProbe, { size: 'sm', onClick: () => void probe() });
  const writeBtn = ui.button(t.rvcWrite, { variant: 'primary', size: 'sm', onClick: () => void write() });
  const testBtn = ui.button(t.rvcTest, { size: 'sm', onClick: () => void test() });
  const acts = ui.actions();
  acts.append(probeBtn, writeBtn, testBtn);

  host.append(ui.h('div', 'gsv-detail', t.rvcTestHint), enabled.el, endpointField, knobs, acts, status, audio, msg);

  async function probe(): Promise<void> {
    probeBtn.disabled = true;
    try {
      const r = await ctx.invoke<RvcProbe>('rvcProbe');
      status.textContent = r.state === 'ready' ? t.rvcProbeReady(r.device ?? '', r.model ?? '')
        : r.state === 'not-ready' ? t.rvcProbeNotReady
          : r.state === 'absent' ? t.rvcProbeAbsent
            : r.state === 'off' ? t.rvcProbeOff
              : t.rvcProbeError(r.detail);
    } catch (err) {
      status.textContent = errText(err);
    } finally {
      probeBtn.disabled = false;
    }
  }

  async function write(): Promise<void> {
    msg.textContent = '';
    msg.classList.remove('bad');
    try {
      await ctx.invoke('rvcWrite', [{
        enabled: enabled.checked,
        endpoint: endpoint.value.trim(),
        timeoutMs: Number(timeout.value),
        pitch: Number(pitch.value),
        indexRate: Number(indexRate.value),
      }]);
      ui.toast(t.rvcWriteOk);
      onWrite?.({ enabled: enabled.checked, endpoint: endpoint.value.trim() });
      await probe();
    } catch (err) {
      msg.textContent = errText(err);
      msg.classList.add('bad');
    }
  }

  async function test(): Promise<void> {
    msg.textContent = '';
    msg.classList.remove('bad');
    const busy = ui.busy(t.rvcTest, t.rvcTestBusy);
    testBtn.disabled = true;
    try {
      const blob = await ctx.invokeBinary('rvcTest', []);
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      audio.src = url;
      audio.hidden = false;
      void audio.play().catch(() => undefined);
    } catch (err) {
      msg.textContent = errText(err);
      msg.classList.add('bad');
    } finally {
      busy.dispose();
      testBtn.disabled = false;
    }
  }

  await probe();
}

/**
 * 渲染一个配置字段；保存走面板的 `setConfigValue`，和原配置页是同一份值。
 */
function mountConfigField(ctx: WebUiPanelContext, host: HTMLElement, f: ConfigField, value: unknown, afterSave?: (next: unknown) => void): void {
  const { ui } = ctx;
  const t = panelText(ctx.language);
  let pending: { dispose(): void } | null = null;
  const save = (next: unknown) => {
    void ctx.invoke('setConfigValue', [f.key, next]).then(
      () => { ui.toast(t.saved); afterSave?.(next); },
      (err: unknown) => ui.toast(`${t.saveFailed}: ${errText(err)}`, 'bad'),
    );
  };
  const commit = (next: unknown, immediate = false) => {
    pending?.dispose();
    pending = null;
    if (immediate) save(next);
    else pending = ctx.timeout(() => { pending = null; save(next); }, 350);
  };

  let control: HTMLElement;
  if (f.type === 'boolean') {
    control = ui.checkbox('', { checked: !!value, onChange: (v: boolean) => commit(v, true) }).el;
  } else if (f.options?.length) {
    const current = f.options.some((o) => o.value === String(value ?? '')) ? String(value ?? '') : f.options[0].value;
    control = ui.select({ value: current, options: f.options, onChange: (v: string) => commit(v, true) });
  } else if (f.path) {
    const input = ui.input({ value: value == null ? '' : String(value), onChange: (v: string) => commit(v) });
    const pick = ui.button(f.path.kind === 'directory' ? t.chooseDir : t.chooseFile, {
      size: 'sm',
      onClick: () => {
        void ctx.pickPath({
          kind: f.path?.kind === 'directory' ? 'directory' : 'file',
          extensions: f.path?.extensions,
          currentPath: input.value,
        }).then((chosen) => {
          if (!chosen) return;
          input.value = chosen;
          commit(chosen, true);
        });
      },
    });
    const row = ui.h('div', 'gsv-acts');
    input.style.flex = '1';
    row.append(input, pick);
    control = row;
  } else if (f.type === 'number' || f.type === 'integer') {
    const input = ui.input({ type: 'number', value: value == null ? '' : String(value), onChange: (v: string) => commit(Number(v)) });
    if (f.minimum !== undefined) input.min = String(f.minimum);
    if (f.maximum !== undefined) input.max = String(f.maximum);
    if (f.multipleOf !== undefined) input.step = String(f.multipleOf);
    control = input;
  } else if (f.key.endsWith('.voice.text')) {
    control = ui.textarea({ value: value == null ? '' : String(value), rows: 2, onChange: (v: string) => commit(v) });
  } else {
    control = ui.input({ value: value == null ? '' : String(value), onChange: (v: string) => commit(v) });
  }

  const wrap = ui.h('div', 'gsv-cfg');
  wrap.append(ui.field(f.title + (f.xHot ? '' : t.restartNeeded), control));
  if (f.description) wrap.append(ui.h('div', 'gsv-detail', f.description));
  host.append(wrap);
}

/**
 * 配置分类页：一个面板 = 一组配置（音色与台词 / 输出与保存 / 推理服务）。
 * 字段标题与说明来自配置组 schema，保存走 `setConfigValue`，和旧配置页是同一份值。
 */
function configPanel(group: string): WebUiPanel {
  return {
    async mount(ctx: WebUiPanelContext) {
      const { ui } = ctx;
      const t = panelText(ctx.language);
      let resp: ConfigResp;
      try {
        resp = await ctx.invoke<ConfigResp>('config', [group, '', false]);
      } catch (err) {
        ctx.root.append(ui.msgline(errText(err), true));
        return;
      }
      if (!resp || !Array.isArray(resp.properties)) {
        ctx.root.append(ui.msgline(errText((resp as unknown as { error?: string })?.error ?? 'config unavailable'), true));
        return;
      }
      const sheet = ui.sheet({ title: resp.title || group, desc: resp.description });
      ctx.root.append(sheet.el);
      if (!resp.properties.length) {
        sheet.body.append(ui.placeholder(t.noFields));
        return;
      }
      for (const f of resp.properties) mountConfigField(ctx, sheet.body, f, resp.values[f.key]);
    },
  };
}

type LinkCard = { el: HTMLElement; body: HTMLElement; note: HTMLElement };

/**
 * 「与其他插件联动」：按插件拆成可折叠卡片（中文大标题 + 英文小标题），折叠时右侧一行摘要。
 * 折叠状态与展开/收起交给宿主的 `ui.foldSheet`（存面板 memo，与听搭子设置页同一套原语）；
 * 老宿主没有这个原语时退回普通卡，不白屏。摘要在每次保存成功后重算，不整页重绘。
 */
function linkPanel(): WebUiPanel {
  return {
    async mount(ctx: WebUiPanelContext) {
      const { ui } = ctx;
      const t = panelText(ctx.language);
      let resp: ConfigResp;
      try {
        resp = await ctx.invoke<ConfigResp>('config', ['world:gpt-sovits:link', '', false]);
      } catch (err) {
        ctx.root.append(ui.msgline(errText(err), true));
        return;
      }
      if (!resp || !Array.isArray(resp.properties)) {
        ctx.root.append(ui.msgline(errText((resp as unknown as { error?: string })?.error ?? 'config unavailable'), true));
        return;
      }

      const values: Record<string, unknown> = { ...resp.values };
      const value = (suffix: string): unknown => {
        const key = resp.properties.find((f) => f.key.endsWith(suffix))?.key;
        return key === undefined ? undefined : values[key];
      };
      const text = (suffix: string, fallback = ''): string => {
        const v = value(suffix);
        return v == null || v === '' ? fallback : String(v);
      };

      const foldSheet = (ui as unknown as {
        foldSheet?: (id: string, opts: { title: string; en?: string; desc?: string; defaultOpen?: boolean }) => LinkCard;
      }).foldSheet;
      const card = (id: string, title: string, en: string, desc: string): LinkCard => {
        if (typeof foldSheet === 'function') {
          const s = foldSheet.call(ui, id, { title, en, desc, defaultOpen: false });
          return { el: s.el, body: s.body, note: s.note };
        }
        const s = ui.sheet({ title, en, desc });
        return { el: s.el, body: s.body, note: s.note };
      };

      const notes: Array<() => void> = [];
      const refresh = (): void => { for (const draw of notes) draw(); };
      const mount = (host: HTMLElement, suffix: string): void => {
        const f = resp.properties.find((item) => item.key.endsWith(suffix));
        if (!f) return;
        mountConfigField(ctx, host, f, values[f.key], (next) => {
          values[f.key] = next;
          refresh();
        });
      };
      // 一键写入会绕过上面的逐字段保存：重新拉一次配置再刷新摘要。
      const reload = async (): Promise<void> => {
        try {
          const next = await ctx.invoke<ConfigResp>('config', ['world:gpt-sovits:link', '', false]);
          if (next && Array.isArray(next.properties)) for (const [k, v] of Object.entries(next.values)) values[k] = v;
        } catch {
          // 拉不到就保留旧值，摘要不闪。
        }
        refresh();
      };

      // 新版 QQ 插件（cortico-world-qq-final / NapCat）：本机语音接口 + 渠道语音 + 对接指南。
      const fresh = card('link-qq-final', t.newQqTitle, 'cortico-world-qq-final', t.newQqDesc);
      notes.push(() => {
        fresh.note.textContent = `${t.sumApi(value('.httpApi') === true, text('.httpPort', '9880'))} · ${t.sumToken(text('.httpToken') !== '')}`;
      });
      ctx.root.append(fresh.el);
      for (const suffix of ['.httpApi', '.httpPort', '.httpToken', '.channelVoice']) mount(fresh.body, suffix);
      await mountQqGuide(ctx, fresh.body, () => void reload());

      // QQ Bot 插件（cortico-world-qqbot）：音频句柄 + FFmpeg。
      const bot = card('link-qqbot', t.qqbotTitle, 'cortico-world-qqbot', t.qqbotDesc);
      notes.push(() => { bot.note.textContent = value('.qqbotVoice') === true ? t.sumOn : t.sumOff; });
      ctx.root.append(bot.el);
      mount(bot.body, '.qqbotVoice');

      // 旧版 QQ 插件（cortico-world-qq）：附件句柄。
      const legacy = card('link-old-qq', t.oldQqTitle, 'cortico-world-qq', t.oldQqDesc);
      notes.push(() => { legacy.note.textContent = value('.shareAudio') === true ? t.sumOn : t.sumOff; });
      ctx.root.append(legacy.el);
      mount(legacy.body, '.shareAudio');

      // DiffSinger 唱歌：地址。
      const sing = card('link-sing', t.singTitle, 'cortico-world-singer-for-coopanion', t.singDesc);
      notes.push(() => { sing.note.textContent = t.sumValue(text('.singUrl')); });
      ctx.root.append(sing.el);
      mount(sing.body, '.singUrl');

      // RVC 出口变声：卡内自己写配置，写入成功后按它回传的值刷新摘要。
      const rvcState = { enabled: value('.rvc.enabled') === true, endpoint: text('.rvc.endpoint') };
      const rvc = card('link-rvc', t.rvcTitle, 'cortico-world-rvc-for-coopanion', t.rvcDesc);
      notes.push(() => {
        rvc.note.textContent = rvcState.enabled ? `${t.sumOn} · ${rvcState.endpoint}` : t.sumOff;
      });
      ctx.root.append(rvc.el);
      await mountRvcCard(ctx, rvc.body, values, (next) => {
        Object.assign(rvcState, next);
        refresh();
      });

      refresh();
    },
  };
}

const bundle: WebUiClientBundle = {
  panels: {
    voice: voicePanel,
    voices: voicesPanel,
    'cfg-voice': configPanel('world:gpt-sovits'),
    'cfg-output': configPanel('world:gpt-sovits:output'),
    'cfg-link': linkPanel(),
    'cfg-service': configPanel('world:gpt-sovits:service'),
    train: trainPanel,
  },
};
export default bundle;
