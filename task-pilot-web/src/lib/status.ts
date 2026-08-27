import { escapeAttr, escapeHtml } from './ui';
import type { CaseExecStatus, CaseExecution, RunStatus } from '@/types';

export const RUN_STATUS_MAP: Record<RunStatus, { cls: string; label: string }> = {
  PENDING: { cls: 'queue', label: 'PENDING' },
  RUNNING: { cls: 'run', label: 'RUNNING' },
  SUCCEEDED: { cls: 'ok', label: 'SUCCEEDED' },
  FAILED: { cls: 'err', label: 'FAILED' },
  STOPPED: { cls: 'ash', label: 'STOPPED' },
};

export const CASE_STATUS_MAP: Record<CaseExecStatus, { cls: string; label: string }> = {
  PENDING: { cls: 'queue', label: '排队中' },
  TEST_RUNNING: { cls: 'run', label: '测试执行中' },
  TEST_DONE: { cls: 'queue', label: '待评测' },
  EVAL_RUNNING: { cls: 'run', label: '评测执行中' },
  REPORTED: { cls: 'ok', label: '已生成报告' },
  ERROR: { cls: 'err', label: '异常' },
  STOPPED: { cls: 'ash', label: '已停止' },
};

export function badgeHtml<T extends string>(map: Record<T, { cls: string; label: string }>, statusKey: T): string {
  const m = map[statusKey] || { cls: 'ash', label: statusKey };
  return `<span class="badge ${m.cls}"><span class="pulse"></span>${m.label}</span>`;
}

export function caseMessageTagHtml(ce: CaseExecution): string {
  const msg = (ce.message || '').trim();
  if (!msg) return '';
  const lower = msg.toLowerCase();
  const presets: { re: RegExp; label: string; icon: string; tone?: string }[] = [
    { re: /analysis\s+report\s+generated|report\s+generated|报告.*生成/, label: '分析报告已生成', icon: '✓', tone: 'ok' },
    { re: /test\s+(task\s+)?(done|completed|succeeded)|测试.*(完成|成功)/, label: '测试已完成', icon: '✓', tone: 'ok' },
    { re: /eval\s+(task\s+)?(done|completed|succeeded)|评测.*(完成|成功)/, label: '评测已完成', icon: '✓', tone: 'ok' },
    { re: /running|执行中|运行中/, label: '执行中', icon: '•', tone: 'run' },
    { re: /pending|queued|排队|等待/, label: '排队中', icon: '•', tone: 'queue' },
  ];
  const preset = presets.find(p => p.re.test(lower) || p.re.test(msg));
  const isError = ce.status === 'ERROR' || /error|failed|exception|失败|异常|错误/.test(lower);
  const tone = isError ? 'err' : (preset?.tone || 'ash');
  const label = preset?.label || msg;
  return `<div class="case-tags"><span class="case-message-tag ${tone}" title="${escapeAttr(msg)}"><span class="tag-icon">${escapeHtml(preset?.icon || (isError ? '!' : 'i'))}</span>${escapeHtml(label)}</span></div>`;
}
