package job

import (
	"strings"
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
)

func TestBuildInjectsExtraEnvSorted(t *testing.T) {
	task := &model.Task{
		ID:           "task-x",
		JobName:      "task-x-job",
		Namespace:    "task-pilot",
		Image:        "alpine:3.20",
		Command:      "echo hi",
		ExtraEnvJSON: model.EncodeEnv(map[string]string{"TARGET_API_KEY": "sk-secret", "TARGET_BASE_URL": "https://x/v1", "TARGET_MODEL_NAME": "m"}),
	}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	// 每个 Job 必须挂载自己的 emptyDir（硬隔离），不得使用共享 hostPath。
	vols := job.Spec.Template.Spec.Volumes
	if len(vols) != 1 || vols[0].EmptyDir == nil {
		t.Fatalf("expected a single emptyDir volume, got %+v", vols)
	}
	if vols[0].HostPath != nil {
		t.Error("hostPath volume must not be used")
	}

	env := job.Spec.Template.Spec.Containers[0].Env
	found := map[string]string{}
	for _, e := range env {
		found[e.Name] = e.Value
	}
	for k, want := range map[string]string{"TARGET_API_KEY": "sk-secret", "TARGET_BASE_URL": "https://x/v1", "TARGET_MODEL_NAME": "m"} {
		if found[k] != want {
			t.Errorf("env %s = %q, want %q", k, found[k], want)
		}
	}
	// 基础 env 仍在。
	if found["TASK_ID"] != "task-x" {
		t.Errorf("base env TASK_ID missing, got %q", found["TASK_ID"])
	}

	// 额外 env 应按 key 排序追加，保证确定性。
	var idxAPIKey, idxBaseURL, idxModel int = -1, -1, -1
	for i, e := range env {
		switch e.Name {
		case "TARGET_API_KEY":
			idxAPIKey = i
		case "TARGET_BASE_URL":
			idxBaseURL = i
		case "TARGET_MODEL_NAME":
			idxModel = i
		}
	}
	if !(idxAPIKey < idxBaseURL && idxBaseURL < idxModel) {
		t.Errorf("extra env not sorted: api_key=%d base_url=%d model=%d", idxAPIKey, idxBaseURL, idxModel)
	}
}

func TestBuildScriptUploadsArtifactsEvenWhenCommandFails(t *testing.T) {
	task := &model.Task{
		ID:        "task-x",
		JobName:   "task-x-job",
		Namespace: "task-pilot",
		Image:     "alpine:3.20",
		Command:   "echo before-fail > output/trace.jsonl\nexit 7",
	}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60}, config.FileTransferConfig{WorkspaceMountPath: "/workspace", ServiceBaseURL: "http://task-pilot"})
	script := job.Spec.Template.Spec.Containers[0].Args[0]
	for _, want := range []string{"set +e", "TASK_EXIT_CODE=$?", "tar -czf", "tasks/$TASK_ID/artifacts", `exit "$TASK_EXIT_CODE"`} {
		if !strings.Contains(script, want) {
			t.Errorf("script should upload artifacts before returning user command exit code; missing %q\n%s", want, script)
		}
	}
}

func TestBuildDefaultsToImageUserWhenExecutorRunAsUserUnset(t *testing.T) {
	task := &model.Task{ID: "task-x", JobName: "task-x-job", Namespace: "task-pilot", Image: "alpine:3.20", Command: "echo hi"}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	pod := job.Spec.Template.Spec
	if pod.SecurityContext != nil {
		t.Errorf("pod SecurityContext should be nil when ExecutorRunAsUser is unset, got %+v", pod.SecurityContext)
	}
	if pod.Containers[0].SecurityContext != nil {
		t.Errorf("container SecurityContext should be nil when ExecutorRunAsUser is unset, got %+v", pod.Containers[0].SecurityContext)
	}
	if len(pod.InitContainers) != 0 {
		t.Errorf("no init container needed when ExecutorRunAsUser is unset (root can mkdir its own workspace), got %+v", pod.InitContainers)
	}
	for _, e := range pod.Containers[0].Env {
		if e.Name == "HOME" {
			t.Errorf("HOME should not be set when ExecutorRunAsUser is unset, got %+v", e)
		}
	}
}

func TestBuildRunsAsConfiguredNonRootUser(t *testing.T) {
	task := &model.Task{ID: "task-x", JobName: "task-x-job", Namespace: "task-pilot", Image: "alpine:3.20", Command: "echo hi"}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60, ExecutorRunAsUser: 1000}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	pod := job.Spec.Template.Spec
	// claude --dangerously-skip-permissions refuses to run as root; RunAsUser/RunAsNonRoot
	// must be set so the pod is rejected by the API server (or crashes fast) instead of
	// silently running as root if the image ignores the requested UID.
	if pod.SecurityContext == nil || pod.SecurityContext.FSGroup == nil || *pod.SecurityContext.FSGroup != 1000 {
		t.Fatalf("pod SecurityContext.FSGroup = %+v, want 1000 (so the mounted emptyDir stays writable by the non-root UID)", pod.SecurityContext)
	}
	cs := pod.Containers[0].SecurityContext
	if cs == nil || cs.RunAsUser == nil || *cs.RunAsUser != 1000 {
		t.Fatalf("container SecurityContext.RunAsUser = %+v, want 1000", cs)
	}
	if cs.RunAsNonRoot == nil || !*cs.RunAsNonRoot {
		t.Error("container SecurityContext.RunAsNonRoot must be true to fail fast instead of silently running as root")
	}

	// fsGroup alone is not reliable across all CSI drivers/kubelet versions to make
	// the emptyDir group-writable by the non-root UID (observed real failure:
	// "mkdir: cannot create directory '.../input': Permission denied" even with
	// fsGroup set). A root init container that mkdir+chmod's this task's workspace
	// subdirectory before the non-root executor starts is required for correctness.
	if len(pod.InitContainers) != 1 {
		t.Fatalf("expected exactly one init container to prepare workspace permissions, got %+v", pod.InitContainers)
	}
	initC := pod.InitContainers[0]
	if initC.SecurityContext == nil || initC.SecurityContext.RunAsUser == nil || *initC.SecurityContext.RunAsUser != 0 {
		t.Errorf("init container must run as root to chmod the workspace, got SecurityContext=%+v", initC.SecurityContext)
	}
	initScript := initC.Args[0]
	if !strings.Contains(initScript, "mkdir -p") || !strings.Contains(initScript, "chmod") {
		t.Errorf("init container script must mkdir and chmod the task workspace, got %q", initScript)
	}
	if !strings.Contains(initScript, "/workspace/tasks/task-x") {
		t.Errorf("init container script must target this task's own workspace subdirectory, got %q", initScript)
	}
	if len(initC.VolumeMounts) != 1 || initC.VolumeMounts[0].Name != "task-files" {
		t.Errorf("init container must mount the same task-files volume as the executor, got %+v", initC.VolumeMounts)
	}

	found := map[string]string{}
	for _, e := range pod.Containers[0].Env {
		found[e.Name] = e.Value
	}
	// HOME must be redirected into the task's own emptyDir: the image's /etc/passwd
	// has no entry for an arbitrary UID, so $HOME would otherwise be unset/unwritable
	// and tools that persist state under $HOME (e.g. Claude Code's $HOME/.claude) would fail.
	if !strings.HasPrefix(found["HOME"], "/workspace/tasks/task-x/") {
		t.Errorf("HOME = %q, want a path inside this task's own emptyDir workspace", found["HOME"])
	}

	script := pod.Containers[0].Args[0]
	if !strings.Contains(script, `mkdir -p "$HOME"`) {
		t.Errorf("script must create $HOME before use, missing mkdir -p \"$HOME\":\n%s", script)
	}
}

func TestBuildInjectsPlaywrightBrowsersPathWhenConfigured(t *testing.T) {
	task := &model.Task{ID: "task-y", JobName: "task-y-job", Namespace: "task-pilot", Image: "alpine:3.20", Command: "echo hi"}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60, ExecutorPlaywrightBrowsersPath: "/opt/ms-playwright"}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	found := map[string]string{}
	for _, e := range job.Spec.Template.Spec.Containers[0].Env {
		found[e.Name] = e.Value
	}
	// Must point at the fixed, image-baked path — independent of this task's own
	// per-task $HOME (isolation requirement) — so Playwright doesn't go looking
	// for chromium under the freshly-created empty per-task HOME.
	if found["PLAYWRIGHT_BROWSERS_PATH"] != "/opt/ms-playwright" {
		t.Errorf("PLAYWRIGHT_BROWSERS_PATH = %q, want %q", found["PLAYWRIGHT_BROWSERS_PATH"], "/opt/ms-playwright")
	}
}

func TestBuildOmitsPlaywrightBrowsersPathWhenUnset(t *testing.T) {
	task := &model.Task{ID: "task-z", JobName: "task-z-job", Namespace: "task-pilot", Image: "alpine:3.20", Command: "echo hi"}
	job := Build(task, config.KubernetesConfig{DefaultTimeoutSeconds: 60}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	for _, e := range job.Spec.Template.Spec.Containers[0].Env {
		if e.Name == "PLAYWRIGHT_BROWSERS_PATH" {
			t.Errorf("PLAYWRIGHT_BROWSERS_PATH should not be set when ExecutorPlaywrightBrowsersPath is unset, got %+v", e)
		}
	}
}

func TestBuildStagesPlaywrightBrowsersIntoSharedVolumeWhenNonRoot(t *testing.T) {
	task := &model.Task{ID: "task-w", JobName: "task-w-job", Namespace: "task-pilot", Image: "alpine:3.20", Command: "echo hi"}
	job := Build(task, config.KubernetesConfig{
		DefaultTimeoutSeconds:          60,
		ExecutorRunAsUser:              1000,
		ExecutorPlaywrightBrowsersPath: "/root/.cache/ms-playwright",
	}, config.FileTransferConfig{WorkspaceMountPath: "/workspace"})

	pod := job.Spec.Template.Spec

	// Containers in a Pod don't share a filesystem — only mounted volumes — so a
	// path under /root baked into the image is unreachable by the non-root
	// executor container even after chmod (verified against a real cluster). The
	// executor's env var must instead point at a copy staged inside the shared
	// task-files emptyDir, not at the raw configured /root path.
	found := map[string]string{}
	for _, e := range pod.Containers[0].Env {
		found[e.Name] = e.Value
	}
	got := found["PLAYWRIGHT_BROWSERS_PATH"]
	if got == "" || got == "/root/.cache/ms-playwright" {
		t.Errorf("PLAYWRIGHT_BROWSERS_PATH = %q, want a staged copy path, not the raw /root source", got)
	}

	// Must NOT be inside taskWorkspace: task commands commonly do
	// `find "$WORKSPACE" ... -exec cp -a {} "$WORKSPACE/output/"` to collect
	// produced files for upload. If the staged browser copy (several hundred MB)
	// lived under taskWorkspace, that sweep would pick it up too and inflate
	// output.tar.gz past file_transfer.max_file_size_mb — observed in production
	// as an unrelated "file too large" 400 on a task that never touched
	// Playwright at all.
	taskWorkspacePrefix := "/workspace/tasks/task-w/"
	if strings.HasPrefix(got, taskWorkspacePrefix) {
		t.Errorf("PLAYWRIGHT_BROWSERS_PATH = %q must NOT be inside taskWorkspace (%q) — task commands sweep up everything under $WORKSPACE for upload", got, taskWorkspacePrefix)
	}
	if !strings.HasPrefix(got, "/workspace/") {
		t.Errorf("PLAYWRIGHT_BROWSERS_PATH = %q, want a path still inside the shared task-files volume (/workspace/...) so both containers can see it", got)
	}

	if len(pod.InitContainers) != 1 {
		t.Fatalf("expected exactly one init container, got %+v", pod.InitContainers)
	}
	initScript := pod.InitContainers[0].Args[0]
	if !strings.Contains(initScript, "/root/.cache/ms-playwright") {
		t.Errorf("init container script must copy from the configured source path, got %q", initScript)
	}
	if !strings.Contains(initScript, got) {
		t.Errorf("init container script must stage into the same path exported to the executor (%q), got %q", got, initScript)
	}
}

