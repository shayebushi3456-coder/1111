import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // 开发环境下把 /api 代理到 task-pilot 后端，避免浏览器跨域请求
  // （后端未内置 CORS 中间件）。目标地址来自 TASKPILOT_DEV_PROXY_TARGET，
  // 默认对齐 configs/config.example.yaml 的 server.addr（:8081）。
  const proxyTarget = env.TASKPILOT_DEV_PROXY_TARGET || 'http://127.0.0.1:8081';

  return {
    base: './',
    server: {
      port: 5173,
      open: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
      },
    },
    // `vite preview` 用于本地起服务器验证 `npm run build` 的产物（dist/），
    // 同样代理 /api，方便在未配置反代的机器上也能直接跑起构建产物验收。
    // 正式生产部署请优先使用下方「生产部署」方式（反代或 VITE_API_BASE_URL），
    // 而不是依赖这里的 preview 代理。
    preview: {
      port: 4173,
      open: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
      },
      allowedHosts: ["siflow-auriga.siflow.cn"]
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  };
});
