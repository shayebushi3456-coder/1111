package config

import (
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Server       ServerConfig       `mapstructure:"server"`
	Database     DatabaseConfig     `mapstructure:"database"`
	Kubernetes   KubernetesConfig   `mapstructure:"kubernetes"`
	FileTransfer FileTransferConfig `mapstructure:"file_transfer"`
	Scheduler    SchedulerConfig    `mapstructure:"scheduler"`
	Eval         EvalConfig         `mapstructure:"eval"`
}

// EvalConfig 评测相关配置。EncryptionSecret 用于加密被测端点 api_key，
// 应来自环境变量/Secret（EVAL_ENCRYPTION_SECRET），不要写进版本库。
type EvalConfig struct {
	EncryptionSecret string `mapstructure:"encryption_secret"`
}

type ServerConfig struct {
	Addr string `mapstructure:"addr"`
}

type DatabaseConfig struct {
	Path string `mapstructure:"path"`
}

type KubernetesConfig struct {
	Namespace               string `mapstructure:"namespace"`
	ServiceAccount          string `mapstructure:"service_account"`
	Kubeconfig              string `mapstructure:"kubeconfig"`
	DefaultImage            string `mapstructure:"default_image"`
	DefaultTimeoutSeconds   int64  `mapstructure:"default_timeout_seconds"`
	BackoffLimit            int32  `mapstructure:"backoff_limit"`
	TTLSecondsAfterFinished int32  `mapstructure:"ttl_seconds_after_finished"`
	// ExecutorRunAsUser 执行器容器运行用户 UID。Claude Code 的
	// --dangerously-skip-permissions 拒绝以 root（UID 0）运行，执行器镜像若默认
	// 以 root 启动，必须通过此项覆盖为非 root UID 才能使用该参数跳过权限确认。
	// <=0 表示不设置 SecurityContext.RunAsUser，沿用镜像默认用户（即仍可能是 root）。
	ExecutorRunAsUser int64 `mapstructure:"executor_run_as_user"`
	// ExecutorPlaywrightBrowsersPath 显式指定执行器镜像里 Playwright 浏览器的固化安装
	// 目录（如镜像构建时执行 `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright playwright
	// install chromium` 后的那个路径）。
	//
	// 背景：Playwright 默认按运行时 $HOME 去找浏览器（$HOME/.cache/ms-playwright）。
	// 但每个评测/测试 Job 都有自己独立的 emptyDir 与临时 $HOME（
	// $WORKSPACE/home，见下方 HOME 注入），这是任务间隔离的硬要求，不能去掉。这导致
	// 镜像构建时装在某个固定 $HOME 下的浏览器，运行时在任务专属的空 $HOME 下找不到，
	// 报 "Executable doesn't exist at .../home/.cache/ms-playwright/...".
	// 设置此项后，会在 Job 里注入同名环境变量，让 Playwright 直接去镜像里的固化路径
	// 找浏览器，而不受每任务独立 $HOME 影响——按值查找路径，不扫描/猜测文件系统。
	// 留空表示不注入，沿用 Playwright 默认行为（即前述 bug 会重现）。
	//
	// 若同时设置了 ExecutorRunAsUser（非 root 执行）：此路径通常在镜像里位于
	// /root 下（root 专属，其它 UID 连目录都进不去），而同一 Pod 内的多个容器不共享
	// 文件系统、只共享显式挂载的卷，因此非 root 的执行容器天然访问不到 root 容器的
	// /root（已用真实 Pod 验证：即使 chmod 该目录，非 root 容器仍报
	// "Executable doesn't exist"，因为那是另一个容器自己的 /root，跟 chmod 的
	// 那个 /root 不是同一份文件系统）。此时会自动改为：由 root 的 init container
	// 把这个目录整份拷贝到与执行容器共享的 task-files emptyDir 卷下（对外仍表现为
	// “配置这一项就够了”），并把注入给执行容器的 PLAYWRIGHT_BROWSERS_PATH 指向卷里
	// 拷贝后的路径，而不是原始配置值本身。
	ExecutorPlaywrightBrowsersPath string `mapstructure:"executor_playwright_browsers_path"`
}

type FileTransferConfig struct {
	WorkspaceMountPath string `mapstructure:"workspace_mount_path"`
	StorageDir         string `mapstructure:"storage_dir"`
	MaxFileSizeMB      int64  `mapstructure:"max_file_size_mb"`
	ServiceBaseURL     string `mapstructure:"service_base_url"`
}

type SchedulerConfig struct {
	ReconcileIntervalSeconds int `mapstructure:"reconcile_interval_seconds"`
	// MaxConcurrentTasks 全局并发上限：同时处于运行中的用例任务（测试 + 评测）总数。
	// <=0 表示不限流（回退到即时全量派发行为）。
	MaxConcurrentTasks int `mapstructure:"max_concurrent_tasks"`
	// MaxConcurrentPerRun 单个执行任务（EvalRun）的并发上限：同一 run 内同时处于
	// 运行中的用例任务（测试 + 评测）数。用于防止单个大请求独占全局额度、饿死其他请求。
	// <=0 表示该维度不限流（仅受全局 MaxConcurrentTasks 约束）。
	// 创建 EvalRun 时可通过 max_concurrent 覆盖此默认值。
	MaxConcurrentPerRun int `mapstructure:"max_concurrent_per_run"`
}

func Load() (*Config, error) {
	v := viper.New()
	v.SetConfigType("yaml")
	v.SetConfigName("config.example")
	v.AddConfigPath("./configs")
	v.AddConfigPath("/app/configs")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	v.SetDefault("server.addr", ":8080")
	v.SetDefault("database.path", "./data/tasks.db")
	v.SetDefault("kubernetes.namespace", "task-pilot")
	v.SetDefault("kubernetes.service_account", "task-pilot-executor")
	v.SetDefault("kubernetes.default_image", "registry-cn-beijing.siflow.cn/skyinfer/eval-pod-base:1.3.0-vscs-20260818-3484")
	v.SetDefault("kubernetes.default_timeout_seconds", 3600)
	v.SetDefault("kubernetes.backoff_limit", 0)
	v.SetDefault("kubernetes.ttl_seconds_after_finished", 86400)
	// 默认不设置（0 = 沿用镜像默认用户）。执行器镜像若默认以 root 启动，需要在
	// configs/config.example.yaml 或环境变量 KUBERNETES_EXECUTOR_RUN_AS_USER 中
	// 显式配置为非 root UID（如 1000），否则 claude --dangerously-skip-permissions 会报错拒绝运行。
	v.SetDefault("kubernetes.executor_run_as_user", 0)
	v.SetDefault("file_transfer.workspace_mount_path", "/workspace")
	v.SetDefault("file_transfer.storage_dir", "./data/files")
	v.SetDefault("file_transfer.max_file_size_mb", 10)
	v.SetDefault("file_transfer.service_base_url", "http://task-pilot.task-pilot.svc.cluster.local:8080")
	v.SetDefault("scheduler.reconcile_interval_seconds", 10)
	v.SetDefault("scheduler.max_concurrent_tasks", 20)
	v.SetDefault("scheduler.max_concurrent_per_run", 0)
	v.SetDefault("eval.encryption_secret", "")

	if path := v.GetString("APP_CONFIG"); path != "" {
		v.SetConfigFile(path)
	}
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, err
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
