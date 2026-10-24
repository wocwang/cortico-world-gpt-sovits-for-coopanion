/**
 * 「语音」面板：推理档、运行时、权重、推理服务四行状态与操作，以及试听。
 * 「音色」面板（第二个）：自定义音色的新建/编辑/删除/切换，保存立即生效。
 * 数据经 `ctx.invoke` 走 World 的 `invoke(<panel>, …)`,每秒轮询一次状态。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { panelText } from '../i18n.ts';
import type { PanelState } from '../world.ts';
import './style.css';

const MB = (n: number) => Math.round(n / 1048576);
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

    ctx.root.append(status, test, msg);

    const setPill = (el: HTMLElement, label: string, tone: 'on' | 'off' | 'warn' | 'bad') => {
      el.textContent = label;
      el.dataset.tone = tone;
    };

    function render(s: PanelState) {
      state = s;
      // 推理档
      setPill(tierRow.pill, s.tier === 'cuda' ? t.tierCuda : t.tierCpu, 'on');
      tierRow.detail.textContent = s.tierSetting === 'auto' ? t.tierAuto(s.cudaFound) : '';
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
        setPill(trainedRow.pill, t.trainedOwn, 'on');
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

    const call = async (method: string, args: unknown[] = []) => {
      msg.textContent = '';
      msg.classList.remove('bad');
      try {
        const next = await ctx.invoke<PanelState>(method, args);
        if (next && 'backend' in next) render(next);
      } catch (err) {
        msg.textContent = errText(err);
        msg.classList.add('bad');
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
      if (editingId) await call('update', [editingId, fName.value, b64, fText.value, fGpt.value.trim(), fSov.value.trim()]);
      else await call('add', [fName.value, f!.name, b64, fText.value, fGpt.value.trim(), fSov.value.trim()]);
      closeForm();
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

const bundle: WebUiClientBundle = { panels: { voice: voicePanel, voices: voicesPanel } };
export default bundle;
