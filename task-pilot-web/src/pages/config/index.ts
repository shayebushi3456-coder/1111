import { targetEndpointsApi, evalEndpointsApi } from '@/api/endpoints';
import { promptsApi } from '@/api/prompts';
import { mcpConfigsApi } from '@/api/mcpConfigs';
import { skillConfigsApi } from '@/api/skillConfigs';
import { escapeHtml, emptyStateHtml, errorStateHtml, fmtTime, skeletonRows } from '@/lib/ui';
import { setupMarkdownEditor } from '@/lib/richEditor';
import { cache, loadEvalEndpoints, loadMCPConfigs, loadPrompts, loadSkillConfigs, loadTargetEndpoints } from '@/core/dataCache';
import { closeModal, confirmAction, errMsg, openModal, toast, toastError } from '@/core/feedback';
import type { EndpointKind, EndpointResponse, EvalPrompt, MCPConfig, SkillConfig } from '@/types';

// ================= ENDPOINTS (config center) =================
export async function renderEndpointList(kind: EndpointKind): Promise<void> {
  const wrapId = kind === 'target' ? 'target-endpoint-list' : 'eval-endpoint-list';
  const wrap = document.getElementById(wrapId)!;
  wrap.innerHTML = skeletonRows(3);
  let list: EndpointResponse[];
  try {
    list = kind === 'target' ? await loadTargetEndpoints(true) : await loadEvalEndpoints(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  if (list.length === 0) { wrap.innerHTML = emptyStateHtml('还没有配置端点', '点击右上角新增端点开始配置。'); return; }
  wrap.innerHTML = list.map((e, i) => `
    <div class="row-item" style="grid-template-columns:1.4fr 1.4fr 1fr 100px 90px;animation-delay:${i * 30}ms;cursor:default;">
      <div>
        <div class="row-title">${escapeHtml(e.name)}</div>
        <div class="row-sub">${e.id}</div>
      </div>
      <div>
        <div style="font-size:12.5px;">${escapeHtml(e.model_name)}</div>
        <div class="row-sub" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.base_url)}</div>
      </div>
      <div class="mono row-sub">${escapeHtml(e.api_key_masked)}</div>
      <div>${e.is_default ? '<span class="badge ok">默认</span>' : '<button class="btn btn-ghost btn-sm" data-set-default="' + e.id + '" data-kind="' + kind + '">设为默认</button>'}</div>
      <div class="flex gap-8">
        <button class="icon-btn" style="width:28px;height:28px;" data-edit-ep="${e.id}" data-kind="${kind}" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--err);border-color:var(--err-soft);" data-del-ep="${e.id}" data-kind="${kind}" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg></button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-set-default]').forEach(el => el.addEventListener('click', async () => {
    const kindAttr = el.getAttribute('data-kind') as EndpointKind;
    const epId = el.getAttribute('data-set-default')!;
    const arr = kindAttr === 'target' ? await loadTargetEndpoints() : await loadEvalEndpoints();
    const ep = arr.find(x => x.id === epId);
    if (!ep) return;
    try {
      const api = kindAttr === 'target' ? targetEndpointsApi : evalEndpointsApi;
      await api.update(epId, { name: ep.name, base_url: ep.base_url, model_name: ep.model_name, api_key: '', is_default: true });
      if (kindAttr === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
      renderEndpointList(kindAttr);
      toast('默认端点已更新');
    } catch (e) {
      toastError('更新失败', e);
    }
  }));
  wrap.querySelectorAll('[data-edit-ep]').forEach(el => el.addEventListener('click', () => openEndpointModal(el.getAttribute('data-kind') as EndpointKind, el.getAttribute('data-edit-ep'))));
  wrap.querySelectorAll('[data-del-ep]').forEach(el => el.addEventListener('click', () => {
    const kind2 = el.getAttribute('data-kind') as EndpointKind, id2 = el.getAttribute('data-del-ep')!;
    confirmAction('删除端点', '删除后使用该端点的历史评测执行记录仍会保留，但无法再用于新的执行。', async () => {
      try {
        const api = kind2 === 'target' ? targetEndpointsApi : evalEndpointsApi;
        await api.remove(id2);
        if (kind2 === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
        renderEndpointList(kind2);
        toast('端点已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}

let epModalKind: EndpointKind = 'target';
let epModalEditId: string | null = null;
document.getElementById('btn-new-target-endpoint')!.addEventListener('click', () => openEndpointModal('target', null));
document.getElementById('btn-new-eval-endpoint')!.addEventListener('click', () => openEndpointModal('eval', null));
async function openEndpointModal(kind: EndpointKind, editId: string | null): Promise<void> {
  epModalKind = kind; epModalEditId = editId;
  const arr = kind === 'target' ? await loadTargetEndpoints() : await loadEvalEndpoints();
  const ep = editId ? arr.find(e => e.id === editId) : null;
  document.getElementById('ep-modal-title')!.textContent = ep ? '编辑端点' : '新增端点';
  document.getElementById('ep-modal-desc')!.textContent = kind === 'target' ? '配置被测 agent 使用的模型接入参数。' : '配置驱动评测 LLM 的模型接入参数。';
  (document.getElementById('ep-name') as HTMLInputElement).value = ep ? ep.name : '';
  (document.getElementById('ep-baseurl') as HTMLInputElement).value = ep ? ep.base_url : '';
  (document.getElementById('ep-model') as HTMLInputElement).value = ep ? ep.model_name : '';
  const apikeyInput = document.getElementById('ep-apikey') as HTMLInputElement;
  apikeyInput.value = '';
  apikeyInput.placeholder = ep ? '留空则保留原值' : 'sk-xxxxxxxxxxxx';
  document.getElementById('ep-default-switch')!.classList.toggle('on', ep ? ep.is_default : false);
  openModal('modal-endpoint');
}
document.getElementById('ep-default-switch')!.addEventListener('click', (e) => (e.currentTarget as HTMLElement).classList.toggle('on'));
document.getElementById('ep-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('ep-submit') as HTMLButtonElement;
  const name = (document.getElementById('ep-name') as HTMLInputElement).value.trim();
  const baseUrl = (document.getElementById('ep-baseurl') as HTMLInputElement).value.trim();
  const model = (document.getElementById('ep-model') as HTMLInputElement).value.trim();
  const apiKey = (document.getElementById('ep-apikey') as HTMLInputElement).value.trim();
  if (!name || !baseUrl || !model) { toast('请完整填写名称 / Base URL / 模型名称'); return; }
  if (!epModalEditId && !apiKey) { toast('新增端点需填写 API Key'); return; }
  const isDefault = document.getElementById('ep-default-switch')!.classList.contains('on');
  btn.disabled = true;
  try {
    const api = epModalKind === 'target' ? targetEndpointsApi : evalEndpointsApi;
    const body = { name, base_url: baseUrl, model_name: model, api_key: apiKey, is_default: isDefault };
    if (epModalEditId) await api.update(epModalEditId, body);
    else await api.create(body);
    if (epModalKind === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
    closeModal('modal-endpoint');
    renderEndpointList(epModalKind);
    toast(epModalEditId ? '端点已更新' : '端点已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= PROMPTS =================
export async function renderPromptGrid(): Promise<void> {
  const wrap = document.getElementById('prompt-grid')!;
  wrap.innerHTML = skeletonRows(3, 160);
  let prompts: EvalPrompt[];
  try {
    prompts = await loadPrompts(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  wrap.innerHTML = prompts.map((p, i) => `
    <div class="panel" style="animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 50}ms">
      <div class="panel-head">
        <h3>${escapeHtml(p.name)}</h3>
        ${p.is_default ? '<span class="badge ok">默认</span>' : `<button class="btn btn-ghost btn-sm" data-set-default-prompt="${p.id}">设为默认</button>`}
      </div>
      <div class="panel-body pad">
        <p class="mono" style="font-size:12px;color:var(--quiet);white-space:pre-wrap;max-height:120px;overflow:hidden;line-height:1.7;margin-bottom:12px;">${escapeHtml(p.content.slice(0, 220))}${p.content.length > 220 ? '…' : ''}</p>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" data-edit-prompt="${p.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--err);border-color:var(--err-soft);" data-del-prompt="${p.id}">删除</button>
        </div>
      </div>
    </div>
  `).join('') || emptyStateHtml('还没有 Prompt', '点击右上角新建 Prompt。');
  wrap.querySelectorAll('[data-set-default-prompt]').forEach(el => el.addEventListener('click', async () => {
    const id = el.getAttribute('data-set-default-prompt')!;
    const p = prompts.find(x => x.id === id);
    if (!p) return;
    try {
      await promptsApi.update(id, { name: p.name, content: p.content, is_default: true });
      cache.prompts = null;
      renderPromptGrid();
      toast('默认 Prompt 已更新');
    } catch (e) {
      toastError('更新失败', e);
    }
  }));
  wrap.querySelectorAll('[data-edit-prompt]').forEach(el => el.addEventListener('click', () => openPromptModal(el.getAttribute('data-edit-prompt'))));
  wrap.querySelectorAll('[data-del-prompt]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-prompt')!;
    confirmAction('删除 Prompt', '已引用该 Prompt 的历史评测执行不受影响（内容已快照）。', async () => {
      try {
        await promptsApi.remove(id);
        cache.prompts = null;
        renderPromptGrid();
        toast('Prompt 已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let promptEditId: string | null = null;
let promptEditorReady = false;
function ensurePromptEditor(): void {
  if (promptEditorReady) return;
  setupMarkdownEditor({
    root: document.getElementById('modal-prompt')!,
    sourceSelector: '#pm-content',
    previewSelector: '#pm-preview',
    toggleSelector: '.cs-md-toggle-preview',
    editorSelector: '.cs-md-editor',
    statsSelector: '#pm-content-stats',
  });
  promptEditorReady = true;
}
document.getElementById('btn-new-prompt')!.addEventListener('click', () => openPromptModal(null));
async function openPromptModal(editId: string | null): Promise<void> {
  promptEditId = editId;
  ensurePromptEditor();
  const prompts = editId ? await loadPrompts() : [];
  const p = editId ? prompts.find(x => x.id === editId) : null;
  document.getElementById('pm-modal-title')!.textContent = p ? '编辑 Prompt' : '新建 Prompt';
  (document.getElementById('pm-name') as HTMLInputElement).value = p ? p.name : '';
  const content = document.getElementById('pm-content') as HTMLTextAreaElement;
  content.value = p ? p.content : '';
  content.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('pm-default-switch')!.classList.toggle('on', p ? p.is_default : false);
  openModal('modal-prompt');
}
document.getElementById('pm-default-switch')!.addEventListener('click', (e) => (e.currentTarget as HTMLElement).classList.toggle('on'));
document.getElementById('pm-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('pm-submit') as HTMLButtonElement;
  const name = (document.getElementById('pm-name') as HTMLInputElement).value.trim();
  const content = (document.getElementById('pm-content') as HTMLTextAreaElement).value.trim();
  if (!name || !content) { toast('请填写名称与内容'); return; }
  const isDefault = document.getElementById('pm-default-switch')!.classList.contains('on');
  btn.disabled = true;
  try {
    if (promptEditId) await promptsApi.update(promptEditId, { name, content, is_default: isDefault });
    else await promptsApi.create({ name, content, is_default: isDefault });
    cache.prompts = null;
    closeModal('modal-prompt');
    renderPromptGrid();
    toast(promptEditId ? 'Prompt 已更新' : 'Prompt 已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= MCP SERVERS (config center) =================
export async function renderMCPConfigList(): Promise<void> {
  const wrap = document.getElementById('mcp-config-list')!;
  wrap.innerHTML = skeletonRows(3);
  let list: MCPConfig[];
  try {
    list = await loadMCPConfigs(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  if (list.length === 0) { wrap.innerHTML = emptyStateHtml('还没有配置 MCP 服务器', '点击右上角新增，供用例编排时勾选绑定。'); return; }
  wrap.innerHTML = list.map((m, i) => `
    <div class="row-item" style="grid-template-columns:1.2fr 2fr 90px;animation-delay:${i * 30}ms;cursor:default;">
      <div>
        <div class="row-title">${escapeHtml(m.name)}</div>
        <div class="row-sub">${escapeHtml(m.description || '--')}</div>
      </div>
      <div class="mono row-sub" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.config_json)}</div>
      <div class="flex gap-8">
        <button class="icon-btn" style="width:28px;height:28px;" data-edit-mcp="${m.id}" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--err);border-color:var(--err-soft);" data-del-mcp="${m.id}" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg></button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-edit-mcp]').forEach(el => el.addEventListener('click', () => openMCPConfigModal(el.getAttribute('data-edit-mcp'))));
  wrap.querySelectorAll('[data-del-mcp]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-mcp')!;
    confirmAction('删除 MCP 服务器', '已被用例绑定的引用会在下次派发测试任务时被静默跳过，不影响用例本身。', async () => {
      try {
        await mcpConfigsApi.remove(id);
        cache.mcpConfigs = null;
        renderMCPConfigList();
        toast('MCP 服务器已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let mcpConfigEditId: string | null = null;
document.getElementById('btn-new-mcp-config')!.addEventListener('click', () => openMCPConfigModal(null));
async function openMCPConfigModal(editId: string | null): Promise<void> {
  mcpConfigEditId = editId;
  const list = editId ? await loadMCPConfigs() : [];
  const m = editId ? list.find(x => x.id === editId) : null;
  document.getElementById('mcp-modal-title')!.textContent = m ? '编辑 MCP 服务器' : '新增 MCP 服务器';
  (document.getElementById('mcp-name') as HTMLInputElement).value = m ? m.name : '';
  (document.getElementById('mcp-desc') as HTMLInputElement).value = m ? m.description : '';
  (document.getElementById('mcp-config-json') as HTMLTextAreaElement).value = m ? m.config_json : '';
  openModal('modal-mcp-config');
}
document.getElementById('mcp-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('mcp-submit') as HTMLButtonElement;
  const name = (document.getElementById('mcp-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('mcp-desc') as HTMLInputElement).value.trim();
  const configJson = (document.getElementById('mcp-config-json') as HTMLTextAreaElement).value.trim();
  if (!name || !configJson) { toast('请填写名称与 config_json'); return; }
  try {
    JSON.parse(configJson);
  } catch {
    toast('config_json 不是合法的 JSON');
    return;
  }
  btn.disabled = true;
  try {
    const body = { name, description, config_json: configJson };
    if (mcpConfigEditId) await mcpConfigsApi.update(mcpConfigEditId, body);
    else await mcpConfigsApi.create(body);
    cache.mcpConfigs = null;
    closeModal('modal-mcp-config');
    renderMCPConfigList();
    toast(mcpConfigEditId ? 'MCP 服务器已更新' : 'MCP 服务器已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= SKILLS (config center) =================
// extra_files 在编辑器里表示为一行一条的 "相对路径=内容" 文本，内容中的换行以字面 "\n" 转义，
// 避免多行文本框里同时编辑多个文件时互相污染彼此的换行结构。
function encodeExtraFilesText(files: Record<string, string>): string {
  return Object.entries(files).map(([p, c]) => `${p}=${c.replace(/\n/g, '\\n')}`).join('\n');
}
function decodeExtraFilesText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
    const idx = line.indexOf('=');
    if (idx <= 0) return;
    const relPath = line.slice(0, idx).trim();
    const content = line.slice(idx + 1).replace(/\\n/g, '\n');
    if (relPath) out[relPath] = content;
  });
  return out;
}

export async function renderSkillConfigGrid(): Promise<void> {
  const wrap = document.getElementById('skill-config-grid')!;
  wrap.innerHTML = skeletonRows(3, 160);
  let list: SkillConfig[];
  try {
    list = await loadSkillConfigs(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  wrap.innerHTML = list.map((sk, i) => {
    const extraCount = Object.keys(sk.extra_files || {}).length;
    return `
    <div class="panel" style="animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 50}ms">
      <div class="panel-head">
        <h3>${escapeHtml(sk.name)}</h3>
        <span class="row-sub">${extraCount > 0 ? `${extraCount} 个附加文件` : ''}</span>
      </div>
      <div class="panel-body pad">
        <p class="row-sub" style="margin-bottom:8px;">${escapeHtml(sk.description || '--')}</p>
        <p class="mono" style="font-size:12px;color:var(--quiet);white-space:pre-wrap;max-height:120px;overflow:hidden;line-height:1.7;margin-bottom:12px;">${escapeHtml(sk.content_md.slice(0, 220))}${sk.content_md.length > 220 ? '…' : ''}</p>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" data-edit-skill="${sk.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--err);border-color:var(--err-soft);" data-del-skill="${sk.id}">删除</button>
        </div>
      </div>
    </div>
  `;
  }).join('') || emptyStateHtml('还没有 Skill', '点击右上角新增，供用例编排时勾选绑定。');
  wrap.querySelectorAll('[data-edit-skill]').forEach(el => el.addEventListener('click', () => openSkillConfigModal(el.getAttribute('data-edit-skill'))));
  wrap.querySelectorAll('[data-del-skill]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-skill')!;
    confirmAction('删除 Skill', '已被用例绑定的引用会在下次派发测试任务时被静默跳过，不影响用例本身。', async () => {
      try {
        await skillConfigsApi.remove(id);
        cache.skillConfigs = null;
        renderSkillConfigGrid();
        toast('Skill 已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let skillConfigEditId: string | null = null;
document.getElementById('btn-new-skill-config')!.addEventListener('click', () => openSkillConfigModal(null));
async function openSkillConfigModal(editId: string | null): Promise<void> {
  skillConfigEditId = editId;
  const list = editId ? await loadSkillConfigs() : [];
  const sk = editId ? list.find(x => x.id === editId) : null;
  document.getElementById('skill-modal-title')!.textContent = sk ? '编辑 Skill' : '新增 Skill';
  (document.getElementById('skill-name') as HTMLInputElement).value = sk ? sk.name : '';
  (document.getElementById('skill-desc') as HTMLInputElement).value = sk ? sk.description : '';
  (document.getElementById('skill-content-md') as HTMLTextAreaElement).value = sk ? sk.content_md : '';
  (document.getElementById('skill-extra-files') as HTMLTextAreaElement).value = sk ? encodeExtraFilesText(sk.extra_files || {}) : '';
  openModal('modal-skill-config');
}
document.getElementById('skill-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('skill-submit') as HTMLButtonElement;
  const name = (document.getElementById('skill-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('skill-desc') as HTMLInputElement).value.trim();
  const contentMd = (document.getElementById('skill-content-md') as HTMLTextAreaElement).value.trim();
  const extraFiles = decodeExtraFilesText((document.getElementById('skill-extra-files') as HTMLTextAreaElement).value);
  if (!name || !contentMd) { toast('请填写名称与 SKILL.md 内容'); return; }
  btn.disabled = true;
  try {
    const body = { name, description, content_md: contentMd, extra_files: extraFiles };
    if (skillConfigEditId) await skillConfigsApi.update(skillConfigEditId, body);
    else await skillConfigsApi.create(body);
    cache.skillConfigs = null;
    closeModal('modal-skill-config');
    renderSkillConfigGrid();
    toast(skillConfigEditId ? 'Skill 已更新' : 'Skill 已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

