import { escapeAttr, escapeHtml } from './ui';
import type { IssueTag, ScoreStatus } from '@/types';

// Legacy code mapping, retained only for historical score prompt v1 data.
export const ISSUE_TAG_MAP: Record<string, { label: string; tone: 'err' | 'warn' | 'violet' }> = {
  CHECKPOINT_UNMET: { label: '校验点未满足', tone: 'err' },
  INCOMPLETE_OUTPUT: { label: '输出不完整', tone: 'warn' },
  FORMAT_ERROR: { label: '格式/结构错误', tone: 'warn' },
  HALLUCINATION: { label: '内容失实/编造', tone: 'err' },
  INSTRUCTION_DEVIATION: { label: '偏离任务要求', tone: 'warn' },
  PERFORMANCE_ISSUE: { label: '执行效率/超时', tone: 'warn' },
  TOOL_MISUSE: { label: '工具调用错误', tone: 'err' },
  VISUAL_QUALITY: { label: '视觉/排版质量差', tone: 'violet' },
  ERROR_HANDLING: { label: '异常处理不当', tone: 'err' },
  OTHER: { label: '其他', tone: 'warn' },
};

export function issueTagLabel(code?: string): string {
  if (!code) return '';
  return ISSUE_TAG_MAP[code]?.label || code;
}

function tagTone(tag: IssueTag): 'err' | 'warn' | 'violet' {
  if (tag.kind === 'good' || tag.level === 'L1' || tag.level === 'L2') return 'violet';
  if (tag.level === 'P0' || tag.level === 'P1' || tag.severity === 'high') return 'err';
  return ISSUE_TAG_MAP[tag.code || '']?.tone || 'warn';
}

function tagText(tag: IssueTag): string {
  const label = tag.label || issueTagLabel(tag.code) || '未命名标签';
  return tag.level ? `${label} · ${tag.level}` : label;
}

export function issueTagHtml(tag: IssueTag): string {
  const label = tagText(tag);
  const tone = tagTone(tag);
  const icon = tag.kind === 'good' ? '★' : (tag.level === 'P0' || tag.severity === 'high' ? '!' : '•');
  const titleParts = [tag.module, tag.label || issueTagLabel(tag.code), tag.level, tag.detail].filter(Boolean);
  const title = titleParts.join('｜') || label;
  return `<span class="case-message-tag ${tone}" title="${escapeAttr(title)}"><span class="tag-icon">${icon}</span>${escapeHtml(label)}</span>`;
}

export function issueTagsHtml(tags: IssueTag[] | undefined): string {
  if (!tags || tags.length === 0) return '<span class="muted" style="font-size:12px;">无标签</span>';
  return `<div class="case-tags">${tags.map(issueTagHtml).join('')}</div>`;
}

export const SCORE_STATUS_MAP: Record<ScoreStatus, { cls: string; label: string }> = {
  NOT_APPLICABLE: { cls: 'ash', label: '不支持机评打分' },
  OK: { cls: 'ok', label: 'OK' },
  PARSE_FAILED: { cls: 'queue', label: '机评解析失败' },
};

function scorePillClass(score: number): string {
  if (score >= 4) return 'score-a';
  if (score >= 3) return 'score-a';
  if (score >= 2) return 'score-b';
  return 'score-c';
}

function scoreLabel(score: number): string {
  switch (Math.round(score)) {
    case 0: return '0/4 严重问题';
    case 1: return '1/4 较严重问题';
    case 2: return '2/4 轻微问题';
    case 3: return '3/4 可用';
    case 4: return '4/4 优秀';
    default: return `${score}/4`;
  }
}

export function scorePillHtml(score: number | null | undefined, status: ScoreStatus, scoreError?: string): string {
  if (status !== 'OK' || score == null) {
    const m = SCORE_STATUS_MAP[status] || SCORE_STATUS_MAP.NOT_APPLICABLE;
    const title = status === 'PARSE_FAILED' && scoreError ? escapeAttr(scoreError) : '';
    return `<span class="score-pill score-none" ${title ? `title="${title}"` : ''}><span class="ring"></span>${escapeHtml(m.label)}</span>`;
  }
  const rounded = Math.round(score * 10) / 10;
  return `<span class="score-pill ${scorePillClass(score)}" title="${escapeAttr(scoreLabel(score))}"><span class="ring"></span>${rounded}/4</span>`;
}
