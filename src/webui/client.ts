/**
 * 「语音」面板：推理档、运行时、权重、推理服务四行状态与操作，以及试听。
 * 「音色」面板（第二个）：自定义音色的新建/编辑/删除/切换，保存立即生效。
 * 数据经 `ctx.invoke` 走 World 的 `invoke(<panel>, …)`,每秒轮询一次状态。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { panelText } from '../i18n.ts';
import type { RvcProbe } from '../rvc-link.ts';
import type { PanelState, UsageItem, UsageState } from '../world.ts';
import type { TrainerState } from '../trainer.ts';
import './style.css';

const MB = (n: number) => Math.round(n / 1048576);
/** 面板里显示体积：过 1 GB 用 GB，否则 MB。 */
const sizeText = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${Math.max(1, MB(n))} MB`);
const pct = (done: number, total: number) => (total ? `${Math.round((done / total) * 100)}%` : `${MB(done)} MB`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

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
        if (next && 'backend' in next) render(next);
        else if (next && 'text' in next) { msg.textContent = next.text; msg.classList.toggle('bad', !!next.failed); }
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
      }
    };

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
    const restartBtn = ui.button(t.restart, { size: 'sm', onClick: () => void call('restart') });
    const stopBtn = ui.button(t.stop, { size: 'sm', onClick: () => void call('stop') });
    serverRow.acts.append(startBtn, restartBtn, stopBtn);
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
          : item.id === 'cuda' ? t.runtimeCuda : t.runtimeCpu);

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
    const queue = ui.h('span', 'gsv-detail');
    test.append(line, testActs, queue);

    ctx.root.append(status, models, test, msg);

    const setPill = (el: HTMLElement, label: string, tone: 'on' | 'off' | 'warn' | 'bad') => {
      el.textContent = label;
      el.dataset.tone = tone;
    };

    function render(s: PanelState) {
      state = s;
      // 推理档
      setPill(tierRow.pill, s.tier === 'cuda' ? t.tierCuda : t.tierCpu, 'on');
      // 自动档说明为什么走 CPU；显式选了显卡档但机器没有 NVIDIA 时提前警告，别等下了 4 GB 运行时才失败。
      tierRow.detail.textContent = s.tierSetting === 'auto'
        ? (s.cudaFound ? t.tierAuto(true) : (s.gpu === 'amd' ? t.tierAutoAmd : t.tierAuto(false)))
        : (s.tier === 'cuda' && !s.cudaFound ? t.tierCudaMissing(s.gpu) : '');
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
      restartBtn.hidden = stopBtn.hidden = sv.phase === 'stopped';
      output.textContent = sv.phase === 'error' || sv.phase === 'starting' ? s.output.join('\n') : '';
      output.hidden = !output.textContent;
      // 队列与上次错误（音色在配置页管理，这里只显示状态）
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
 * 「音色」面板：自定义音色的新建、编辑、删除与切换。保存/删除立即生效并刷新列表，
 * 不依赖配置表单（配置页只负责选，字段不随切换刷新）。
 */
const voicesPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui } = ctx;
    const t = panelText(ctx.language);
    const msg = ui.msgline();
    let state: PanelState | null = null;
    let editingId: string | null = null;

    // 返回是否成功：失败时保留表单与错误提示，别让用户以为「点了没反应」。
    const call = async (method: string, args: unknown[] = []): Promise<boolean> => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const next = await ctx.invoke<PanelState>(method, args);
        if (!next || !('backend' in next)) return false;
        render(next);
        return true;
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
        return false;
      }
    };

    const sec = ui.section(t.customVoices, t.customVoicesHint);
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
    sec.append(list, addBtn, form);

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

    function render(s: PanelState): void {
      state = s;
      renderList(s);
    }

    const refresh = async () => {
      try { render(await ctx.invoke<PanelState>('state')); } catch (err) { if (!state) msg.textContent = errText(err); }
    };
    void refresh();
    ctx.interval(() => void refresh(), 1000);

    ctx.root.append(sec, msg);
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
async function mountQqGuide(ctx: WebUiPanelContext, host: HTMLElement): Promise<void> {
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
async function mountRvcCard(ctx: WebUiPanelContext, host: HTMLElement, values: Record<string, unknown>): Promise<void> {
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
function mountConfigField(ctx: WebUiPanelContext, host: HTMLElement, f: ConfigField, value: unknown): void {
  const { ui } = ctx;
  const t = panelText(ctx.language);
  let pending: { dispose(): void } | null = null;
  const save = (next: unknown) => {
    void ctx.invoke('setConfigValue', [f.key, next]).then(
      () => ui.toast(t.saved),
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

/** 「与其他插件联动」：按插件拆成子卡片（中文大标题 + 英文小标题），各自只放相关选项。 */
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
      const fields = new Map(resp.properties.map((f) => [f.key, f]));
      const mount = (host: HTMLElement, suffix: string): void => {
        const f = [...fields.entries()].find(([key]) => key.endsWith(suffix))?.[1];
        if (f) mountConfigField(ctx, host, f, resp.values[f.key]);
      };
      const fresh = ui.sheet({ title: t.newQqTitle, en: 'cortico-world-qq-final', desc: t.newQqDesc });
      ctx.root.append(fresh.el);
      for (const suffix of ['.httpApi', '.httpPort', '.httpToken', '.channelVoice']) mount(fresh.body, suffix);
      await mountQqGuide(ctx, fresh.body);
      const legacy = ui.sheet({ title: t.oldQqTitle, en: 'cortico-world-qq', desc: t.oldQqDesc });
      ctx.root.append(legacy.el);
      mount(legacy.body, '.shareAudio');
      const rvc = ui.sheet({ title: t.rvcTitle, en: 'cortico-world-rvc-for-coopanion', desc: t.rvcDesc });
      ctx.root.append(rvc.el);
      await mountRvcCard(ctx, rvc.body, resp.values);
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
