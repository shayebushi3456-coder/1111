package job

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func Build(task *model.Task, cfg config.KubernetesConfig, ft config.FileTransferConfig) *batchv1.Job {
	backoffLimit := cfg.BackoffLimit
	ttl := cfg.TTLSecondsAfterFinished
	deadline := task.TimeoutSeconds
	if deadline <= 0 {
		deadline = cfg.DefaultTimeoutSeconds
	}

	// Each Job gets its own emptyDir mounted at ft.WorkspaceMountPath (/workspace),
	// providing kernel-level isolation between tasks. WORKSPACE is a per-task
	// subdirectory inside that private volume.
	taskWorkspace := path.Join(ft.WorkspaceMountPath, "tasks", task.ID)

	inputFiles := model.DecodeInputFiles(task.InputFilesJSON)
	prestartFile, inputFiles := splitPrestartInput(inputFiles)
	script := buildScript(task.Command, inputFiles, ft.ServiceBaseURL, prestartFile != nil)

	env := []corev1.EnvVar{
		{Name: "TASK_ID", Value: task.ID},
		{Name: "TASK_TOKEN", Value: task.TaskToken},

		// Per-task isolated workspace, e.g. /workspace/tasks/task-xxx.
		{Name: "WORKSPACE", Value: taskWorkspace},
	}
	// When running as a non-root UID (see ExecutorRunAsUser below), the image's
	// /etc/passwd usually has no matching entry, so $HOME would be unset/unwritable
	// and Claude Code (which persists config/state under $HOME/.claude) would fail.
	// Point HOME at a writable directory inside this task's own emptyDir instead of
	// relying on the image to have a passwd entry for the chosen UID.
	if cfg.ExecutorRunAsUser > 0 {
		env = append(env, corev1.EnvVar{Name: "HOME", Value: path.Join(taskWorkspace, "home")})
	}
	// Playwright resolves its browser install dir from $HOME by default
	// ($HOME/.cache/ms-playwright), but each Job's $HOME is a fresh per-task
	// directory inside its own emptyDir (see above) — that isolation is required
	// and must not change. If the executor image has chromium pre-installed at a
	// fixed path (baked in at image build time), point Playwright at it directly
	// via this env var so it doesn't go looking under the task's empty per-task
	// $HOME. Left unset, Playwright falls back to its default $HOME-relative path.
	//
	// When ExecutorRunAsUser is set, the configured path (typically under /root,
	// e.g. /root/.cache/ms-playwright) is unreachable by the non-root executor
	// container: containers in the same Pod do NOT share a filesystem, only
	// explicitly mounted volumes do, so chmod'ing /root in one container has zero
	// effect on another container's own /root (verified against a real Pod: the
	// executor saw "Executable doesn't exist" at that path even though root could
	// list it fine). In that case we instead point at a copy staged into the
	// shared task-files emptyDir by the root init container below
	// (playwrightBrowsersPathForExecutor), which both containers do share.
	//
	// Staged OUTSIDE taskWorkspace (a sibling "playwright-browsers-<id>" dir at
	// the volume root, not "$taskWorkspace/playwright-browsers"): task commands
	// commonly do `find "$WORKSPACE" ... -exec cp -a {} "$WORKSPACE/output/"` to
	// collect produced files for upload, which would otherwise sweep up this
	// several-hundred-MB browser copy too — inflating output.tar.gz past
	// file_transfer.max_file_size_mb and failing the upload with an unrelated
	// "file too large" 400 (observed in production for a task that never even
	// touched Playwright).
	playwrightBrowsersPathForExecutor := cfg.ExecutorPlaywrightBrowsersPath
	stagedPlaywrightBrowsersPath := ""
	if cfg.ExecutorPlaywrightBrowsersPath != "" && cfg.ExecutorRunAsUser > 0 {
		stagedPlaywrightBrowsersPath = path.Join(ft.WorkspaceMountPath, "playwright-browsers-"+task.ID)
		playwrightBrowsersPathForExecutor = stagedPlaywrightBrowsersPath
	}
	if playwrightBrowsersPathForExecutor != "" {
		env = append(env, corev1.EnvVar{Name: "PLAYWRIGHT_BROWSERS_PATH", Value: playwrightBrowsersPathForExecutor})
	}
	// Proxy envs are propagated from task-pilot server pod to executor jobs.
	// This lets websearch / LLM / external API calls use a unified egress proxy.
	// Keep NO_PROXY configured to avoid routing in-cluster service traffic through proxy.
	for _, k := range []string{
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"no_proxy",
	} {
		if v := os.Getenv(k); v != "" {
			env = append(env, corev1.EnvVar{Name: k, Value: v})
		}
	}
	// Extra env carries model endpoint parameters (base_url/model/api_key)
	// injected by the eval service. Sorted for deterministic ordering.
	if extra := model.DecodeEnv(task.ExtraEnvJSON); len(extra) > 0 {
		keys := make([]string, 0, len(extra))
		for k := range extra {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			env = append(env, corev1.EnvVar{Name: k, Value: extra[k]})
		}
	}
	// Mock HTTP sidecar（前置脚本）默认监听 8000；注入给 executor，Agent/工具可直接调本机接口。
	if prestartFile != nil && prestartFile.FileID != "" {
		env = append(env, corev1.EnvVar{Name: "MOCK_API_BASE_URL", Value: MockAPIBaseURL})
	}

	// Claude Code's --dangerously-skip-permissions refuses to run as root (UID 0).
	// When cfg.ExecutorRunAsUser is configured (>0), force the executor container
	// (and the pod's fsGroup, so the mounted emptyDir stays writable by that UID)
	// to run as that non-root user. Left unset (0), the image's default user is
	// used unchanged — same behavior as before this option existed.
	//
	// fsGroup alone is not a reliable way to make the emptyDir writable by the
	// non-root UID: it depends on the CSI driver/kubelet actually applying group
	// ownership on mount, which some environments skip, leaving the volume root
	// owned by root with no group-write bit (observed failure:
	// "mkdir: cannot create directory '.../input': Permission denied"). To be
	// correct everywhere, run a root init container first that creates this
	// task's workspace subdirectory and opens it up (chmod 0777) before the
	// non-root executor container starts. The emptyDir is fresh per Job, so this
	// has no cross-task blast radius.
	var podSecurityContext *corev1.PodSecurityContext
	var containerSecurityContext *corev1.SecurityContext
	var initContainers []corev1.Container
	if cfg.ExecutorRunAsUser > 0 {
		runAsUser := cfg.ExecutorRunAsUser
		runAsNonRoot := true
		podSecurityContext = &corev1.PodSecurityContext{
			FSGroup: &runAsUser,
		}
		containerSecurityContext = &corev1.SecurityContext{
			RunAsUser:    &runAsUser,
			RunAsNonRoot: &runAsNonRoot,
		}
		initArgs := fmt.Sprintf("mkdir -p %q && chmod -R 0777 %q", taskWorkspace, taskWorkspace)
		if stagedPlaywrightBrowsersPath != "" {
			// Copy chromium out of this (root) container's own /root into the
			// task-files emptyDir, which the non-root executor container also
			// mounts — containers in a Pod share volumes, not filesystems, so this
			// is the only way to hand the non-root container access to a browser
			// baked into the image under a root-only directory. Staged as a
			// sibling of taskWorkspace (not inside it) so task commands that sweep
			// up "everything under $WORKSPACE" for upload don't pick up this
			// several-hundred-MB browser copy too. Best-effort: if the configured
			// source path doesn't exist in this image, skip silently and let the
			// executor's own runner report "browsers not found" rather than
			// failing the whole init container (and thus the Job) over it.
			initArgs += fmt.Sprintf(
				" && { [ -d %q ] && mkdir -p %q && cp -r %q/. %q && chmod -R 0755 %q || true; }",
				cfg.ExecutorPlaywrightBrowsersPath, stagedPlaywrightBrowsersPath,
				cfg.ExecutorPlaywrightBrowsersPath, stagedPlaywrightBrowsersPath, stagedPlaywrightBrowsersPath,
			)
		}
		initContainers = append(initContainers, corev1.Container{
			Name:            "workspace-init",
			Image:           task.Image,
			ImagePullPolicy: corev1.PullIfNotPresent,
			Command:         []string{"sh", "-c"},
			Args:            []string{initArgs},
			VolumeMounts: []corev1.VolumeMount{
				{
					Name:      "task-files",
					MountPath: ft.WorkspaceMountPath,
				},
			},
			// Explicitly root: this container's only job is to prepare permissions
			// for the non-root executor container that runs after it.
			SecurityContext: &corev1.SecurityContext{RunAsUser: int64Ptr(0)},
		})
	}

	volumeMounts := []corev1.VolumeMount{{
		Name:      "task-files",
		MountPath: ft.WorkspaceMountPath,
	}}
	containers := []corev1.Container{{
		Name:            "executor",
		Image:           task.Image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		WorkingDir:      taskWorkspace,
		Command:         []string{"sh", "-c"},
		Args:            []string{script},
		Env:             env,
		SecurityContext: containerSecurityContext,
		VolumeMounts:    volumeMounts,
	}}

	// 前置脚本 sidecar：与 executor 同 Pod、共享 localhost。
	// 适合 serve_forever 的 Mock HTTP；executor 结束时写 .executor-done，sidecar 收到后退出，
	// 避免多容器 Job 因 sidecar 不退出而永远挂起（不依赖 K8s native sidecar 特性）。
	if prestartFile != nil && prestartFile.FileID != "" {
		containers = append(containers, corev1.Container{
			Name:            "prestart-script",
			Image:           task.Image,
			ImagePullPolicy: corev1.PullIfNotPresent,
			WorkingDir:      taskWorkspace,
			Command:         []string{"sh", "-c"},
			Args:            []string{buildPrestartSidecarScript(*prestartFile, ft.ServiceBaseURL)},
			Env:             env,
			SecurityContext: containerSecurityContext,
			VolumeMounts:    volumeMounts,
		})
	}

	return &batchv1.Job{
		TypeMeta: metav1.TypeMeta{APIVersion: "batch/v1", Kind: "Job"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      task.JobName,
			Namespace: task.Namespace,
			Labels: map[string]string{
				"app":     "task-pilot",
				"task-id": task.ID,
			},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			TTLSecondsAfterFinished: &ttl,
			ActiveDeadlineSeconds:   &deadline,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: map[string]string{
						"app":      "task-pilot",
						"task-id":  task.ID,
						"job-name": task.JobName,
					},
				},
				Spec: corev1.PodSpec{
					RestartPolicy:      corev1.RestartPolicyNever,
					ServiceAccountName: cfg.ServiceAccount,
					SecurityContext:    podSecurityContext,
					InitContainers:     initContainers,
					Containers:         containers,
					Volumes: []corev1.Volume{{
						Name: "task-files",
						VolumeSource: corev1.VolumeSource{
							EmptyDir: &corev1.EmptyDirVolumeSource{},
						},
					}},
				},
			},
		},
	}
}

func buildScript(userCommand string, inputFiles []model.InputFileSpec, serviceBaseURL string, waitForMock bool) string {
	var b strings.Builder

	b.WriteString(`set -e

# Per-task isolated workspace inside this Job's private emptyDir volume.
mkdir -p "$WORKSPACE/input" "$WORKSPACE/output" "$WORKSPACE/tmp"
# When running as non-root (see ExecutorRunAsUser), HOME is redirected into this
# task's own emptyDir so tools that persist state under $HOME (e.g. Claude Code's
# $HOME/.claude) have a writable home directory regardless of the image's /etc/passwd.
[ -n "${HOME:-}" ] && mkdir -p "$HOME"
`)

	if waitForMock {
		// sidecar 与 executor 并行启动；等 Mock /health 通再跑测评，避免竞态。
		b.WriteString(`
MOCK_URL="${MOCK_API_BASE_URL:-http://127.0.0.1:8000}"
echo "waiting for mock API at $MOCK_URL/health ..."
i=0
while [ "$i" -lt 90 ]; do
  if curl -fsS "$MOCK_URL/health" >/dev/null 2>&1; then
    echo "mock API ready"
    break
  fi
  i=$((i + 1))
  if [ "$i" -ge 90 ]; then
    echo "mock API not ready after 90s" >&2
    exit 1
  fi
  sleep 1
done
`)
	}

	for _, input := range inputFiles {
		if input.FileID == "" {
			continue
		}

		filename := input.Filename
		if filename == "" && input.MountPath != "" {
			filename = filepath.Base(input.MountPath)
		}
		if filename == "" || filename == "." || filename == "/" {
			filename = input.FileID
		}

		// Only trust the basename. Never write to caller-provided absolute mount_path.
		// This prevents path traversal and avoids cross-case / cross-task pollution.
		safeFilename := filepath.Base(filename)

		url := fmt.Sprintf(
			"\"%s/api/v1/files/%s/download?task_id=$TASK_ID\"",
			strings.TrimRight(serviceBaseURL, "/"),
			input.FileID,
		)

		// Important: do not single-quote $WORKSPACE here. It must expand in the shell.
		targetPath := "\"$WORKSPACE/input/" + shellDoubleQuoteInner(safeFilename) + "\""

		b.WriteString(fmt.Sprintf(
			"curl -fsSL -H \"X-Task-Token: $TASK_TOKEN\" %s -o %s\n",
			url,
			targetPath,
		))
	}

	b.WriteString(`
cd "$WORKSPACE"
`)

	b.WriteString(`
# Run the user command in a subshell so failures (or explicit exit) do not skip
# artifact upload. Preserve the original exit code and return it after upload.
set +e
(
`)

	b.WriteString(strings.TrimSpace(userCommand))
	b.WriteString("\n")

	b.WriteString(fmt.Sprintf(`
)
TASK_EXIT_CODE=$?
set -e

# Upload only this task's isolated output directory. Even failed tasks may have
# useful diagnostics such as output/trace.jsonl, so upload before exiting.
if [ -d "$WORKSPACE/output" ]; then
  rm -rf "$WORKSPACE/tmp/output-staging"
  mkdir -p "$WORKSPACE/tmp/output-staging"
  # Stage artifacts before archiving so accidental tool/runtime state copied into
  # output/ (for example home/, .claude/, .cache/) never reaches output.tar.gz.
  find "$WORKSPACE/output" -maxdepth 1 -mindepth 1 \
    ! -name home ! -name .home ! -name .claude ! -name .cache ! -name .config ! -name .local ! -name node_modules \
    -exec cp -a {} "$WORKSPACE/tmp/output-staging/" \; 2>/dev/null || true
  if [ "$(find "$WORKSPACE/tmp/output-staging" -mindepth 1 -print -quit 2>/dev/null)" ]; then
    tar -czf "$WORKSPACE/tmp/output.tar.gz" -C "$WORKSPACE/tmp/output-staging" .
    curl -fsS -H "X-Task-Token: $TASK_TOKEN" -F "file=@$WORKSPACE/tmp/output.tar.gz" "%s/api/v1/tasks/$TASK_ID/artifacts"
  fi
fi
# 通知 prestart sidecar 可以退出（同 Pod 多容器 Job 要求全部容器结束）。
touch "$WORKSPACE/tmp/.executor-done" 2>/dev/null || true
exit "$TASK_EXIT_CODE"
`, strings.TrimRight(serviceBaseURL, "/")))

	return b.String()
}

func shellDoubleQuoteInner(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, `$`, `\$`)
	value = strings.ReplaceAll(value, "`", "\\`")
	return value
}

// PrestartInputFilename 前置脚本在 input/ 下的固定文件名；派发侧写入，Build 侧识别并挂 sidecar。
const PrestartInputFilename = "__prestart__.py"

// MockAPIBaseURL 同 Pod sidecar Mock HTTP 的默认地址（脚本默认 --port 8000）。
const MockAPIBaseURL = "http://127.0.0.1:8000"

// splitPrestartInput 把前置脚本从普通输入文件中拆出，供 sidecar 单独下载执行。
func splitPrestartInput(files []model.InputFileSpec) (*model.InputFileSpec, []model.InputFileSpec) {
	var prestart *model.InputFileSpec
	rest := make([]model.InputFileSpec, 0, len(files))
	for i := range files {
		f := files[i]
		name := f.Filename
		if name == "" && f.MountPath != "" {
			name = filepath.Base(f.MountPath)
		}
		if filepath.Base(name) == PrestartInputFilename && f.FileID != "" {
			cp := f
			cp.Filename = PrestartInputFilename
			prestart = &cp
			continue
		}
		rest = append(rest, f)
	}
	return prestart, rest
}

// buildPrestartSidecarScript 下载 .py 后后台启动（可 serve_forever），等 executor 写 .executor-done 再退出。
func buildPrestartSidecarScript(file model.InputFileSpec, serviceBaseURL string) string {
	url := fmt.Sprintf(
		"\"%s/api/v1/files/%s/download?task_id=$TASK_ID\"",
		strings.TrimRight(serviceBaseURL, "/"),
		file.FileID,
	)
	target := "\"$WORKSPACE/input/" + shellDoubleQuoteInner(PrestartInputFilename) + "\""
	var b strings.Builder
	b.WriteString("set -e\n")
	b.WriteString("mkdir -p \"$WORKSPACE/input\" \"$WORKSPACE/output\" \"$WORKSPACE/tmp\"\n")
	b.WriteString("[ -n \"${HOME:-}\" ] && mkdir -p \"$HOME\"\n")
	b.WriteString("rm -f \"$WORKSPACE/tmp/.executor-done\"\n")
	b.WriteString(fmt.Sprintf("curl -fsSL -H \"X-Task-Token: $TASK_TOKEN\" %s -o %s\n", url, target))
	b.WriteString("cd \"$WORKSPACE\"\n")
	b.WriteString("python3 \"input/" + PrestartInputFilename + "\" &\n")
	b.WriteString("MOCK_PID=$!\n")
	b.WriteString(`
# 等主容器结束信号；主容器结束后 sidecar 必须退出，否则 Job 不会完成。
while kill -0 "$MOCK_PID" 2>/dev/null; do
  if [ -f "$WORKSPACE/tmp/.executor-done" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    exit 0
  fi
  sleep 1
done
wait "$MOCK_PID"
exit $?
`)
	return b.String()
}
