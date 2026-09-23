package job

import (
	"strings"
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
)

func TestSplitPrestartInput(t *testing.T) {
	pre, rest := splitPrestartInput([]model.InputFileSpec{
		{FileID: "f1", Filename: "data.csv"},
		{FileID: "f2", Filename: PrestartInputFilename},
		{FileID: "f3", Filename: "note.md"},
	})
	if pre == nil || pre.FileID != "f2" {
		t.Fatalf("prestart not split: %+v", pre)
	}
	if len(rest) != 2 || rest[0].FileID != "f1" || rest[1].FileID != "f3" {
		t.Fatalf("rest wrong: %+v", rest)
	}
}

func TestBuildPrestartSidecarScript(t *testing.T) {
	script := buildPrestartSidecarScript(model.InputFileSpec{FileID: "file-abc"}, "http://svc:8081")
	for _, want := range []string{
		"/api/v1/files/file-abc/download?task_id=$TASK_ID",
		`"$WORKSPACE/input/__prestart__.py"`,
		`python3 "input/__prestart__.py" &`,
		".executor-done",
		"MOCK_PID",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("missing %q in:\n%s", want, script)
		}
	}
}

func TestBuildAddsPrestartSidecar(t *testing.T) {
	task := &model.Task{
		ID:             "task-1",
		JobName:        "task-1-job",
		Namespace:      "ns",
		Image:          "img:latest",
		Command:        "echo hi",
		TaskToken:      "tok",
		TimeoutSeconds: 60,
		InputFilesJSON: model.EncodeInputFiles([]model.InputFileSpec{
			{FileID: "file-pre", Filename: PrestartInputFilename},
			{FileID: "file-in", Filename: "a.csv"},
		}),
	}
	job := Build(task, config.KubernetesConfig{BackoffLimit: 0, TTLSecondsAfterFinished: 60, DefaultTimeoutSeconds: 60}, config.FileTransferConfig{
		WorkspaceMountPath: "/workspace",
		ServiceBaseURL:     "http://svc:8081",
	})

	if len(job.Spec.Template.Spec.Containers) != 2 {
		t.Fatalf("want executor+sidecar, got %d containers", len(job.Spec.Template.Spec.Containers))
	}
	var execArgs, sideArgs string
	foundSide := false
	for _, c := range job.Spec.Template.Spec.Containers {
		switch c.Name {
		case "executor":
			execArgs = c.Args[0]
			hasMockEnv := false
			for _, e := range c.Env {
				if e.Name == "MOCK_API_BASE_URL" && e.Value == MockAPIBaseURL {
					hasMockEnv = true
				}
			}
			if !hasMockEnv {
				t.Error("executor missing MOCK_API_BASE_URL")
			}
		case "prestart-script":
			foundSide = true
			sideArgs = c.Args[0]
		}
	}
	if !foundSide {
		t.Fatal("missing prestart-script sidecar container")
	}
	if !strings.Contains(sideArgs, "file-pre") || !strings.Contains(sideArgs, "python3") {
		t.Errorf("sidecar script incomplete: %s", sideArgs)
	}
	if strings.Contains(execArgs, "file-pre") {
		t.Error("prestart file must not be re-downloaded in executor script")
	}
	if !strings.Contains(execArgs, "file-in") {
		t.Error("normal input must still download in executor")
	}
	if !strings.Contains(execArgs, "waiting for mock API") {
		t.Error("executor must wait for mock /health")
	}
	if !strings.Contains(execArgs, ".executor-done") {
		t.Error("executor must signal sidecar to exit")
	}
	for _, c := range job.Spec.Template.Spec.InitContainers {
		if c.Name == "prestart-script" {
			t.Error("prestart must be sidecar container, not initContainer")
		}
	}
}
