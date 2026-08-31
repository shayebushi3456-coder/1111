export function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export interface ChunkRenderOptions<T> {
  container: HTMLElement;
  items: T[];
  renderItem: (item: T, index: number) => string;
  emptyHtml?: string;
  chunkSize?: number;
  beforeRender?: () => void;
  afterRender?: () => void;
}

/**
 * 分片渲染大列表/表格，避免一次性 innerHTML 拼接 + DOM 注入阻塞主线程。
 * 返回的 cancel 可在路由切换或下一轮渲染开始时中断过期渲染任务。
 */
export function renderListInChunks<T>(options: ChunkRenderOptions<T>): { cancel: () => void; done: Promise<void> } {
  const chunkSize = Math.max(1, options.chunkSize || 40);
  let cancelled = false;

  const done = (async () => {
    options.beforeRender?.();
    options.container.innerHTML = '';

    if (options.items.length === 0) {
      if (!cancelled && options.emptyHtml) options.container.innerHTML = options.emptyHtml;
      options.afterRender?.();
      return;
    }

    for (let i = 0; i < options.items.length; i += chunkSize) {
      if (cancelled) return;
      const html = options.items.slice(i, i + chunkSize).map((item, j) => options.renderItem(item, i + j)).join('');
      options.container.insertAdjacentHTML('beforeend', html);
      if (i + chunkSize < options.items.length) await nextFrame();
    }

    if (!cancelled) options.afterRender?.();
  })();

  return {
    cancel: () => { cancelled = true; },
    done,
  };
}

export function delegate(container: HTMLElement, selector: string, handler: (target: HTMLElement, event: MouseEvent) => void): () => void {
  const listener = (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(selector);
    if (!target || !container.contains(target)) return;
    handler(target, event);
  };
  container.addEventListener('click', listener);
  return () => container.removeEventListener('click', listener);
}
