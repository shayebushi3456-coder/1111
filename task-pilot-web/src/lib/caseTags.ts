/** 用例一级/二级类型级联词表（录入下拉用）。 */
export const CASE_LEVEL1_OPTIONS = [
  '信息处理类',
  '流程自动化类',
  '业务数据分析类',
  '沟通协作类',
  '本地效率助手',
] as const;

export const CASE_LEVEL2_BY_LEVEL1: Record<string, readonly string[]> = {
  '信息处理类': ['邮件管理', '文档摘要总结', '知识检索', '信息生成'],
  '流程自动化类': ['流程与审批', '差旅&报销', '行政', '人事人力'],
  '业务数据分析类': ['业务监控', '竞品分析', '结构化数据提取', '报表生成', '财务对账'],
  '沟通协作类': ['客户沟通助手', '职能助手', '会议助手', '多语言写作'],
  '本地效率助手': ['个人知识整理', '工作安排与协助'],
};

/** task 类型多选词表。 */
export const CASE_TASK_TYPE_OPTIONS = [
  '单步',
  '多步',
  '条件分支',
  '多轮交互',
  '并发协作',
  '长程任务',
] as const;

export function level2OptionsOf(level1: string): readonly string[] {
  return CASE_LEVEL2_BY_LEVEL1[level1] || [];
}
