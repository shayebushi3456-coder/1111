package job

import (
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
)

type Phase string

const (
	PhasePending   Phase = "Pending"
	PhaseRunning   Phase = "Running"
	PhaseSucceeded Phase = "Succeeded"
	PhaseFailed    Phase = "Failed"
	PhaseUnknown   Phase = "Unknown"
)

type Status struct {
	Phase        Phase
	Message      string
	PodName      string
	ExitCode     *int
	ContainerLog string
}

func FromJobAndPod(job *batchv1.Job, pod *corev1.Pod) Status {
	status := Status{Phase: PhasePending}
	if job != nil {
		for _, condition := range job.Status.Conditions {
			if condition.Type == batchv1.JobComplete && condition.Status == corev1.ConditionTrue {
				status.Phase = PhaseSucceeded
				status.Message = condition.Message
			}
			if condition.Type == batchv1.JobFailed && condition.Status == corev1.ConditionTrue {
				status.Phase = PhaseFailed
				status.Message = condition.Message
			}
		}
		if status.Phase == PhasePending && job.Status.Active > 0 {
			status.Phase = PhaseRunning
		}
	}
	if pod != nil {
		status.PodName = pod.Name
		switch pod.Status.Phase {
		case corev1.PodRunning:
			status.Phase = PhaseRunning
		case corev1.PodSucceeded:
			status.Phase = PhaseSucceeded
		case corev1.PodFailed:
			status.Phase = PhaseFailed
		}
		for _, cs := range pod.Status.ContainerStatuses {
			if cs.State.Terminated != nil {
				exitCode := int(cs.State.Terminated.ExitCode)
				status.ExitCode = &exitCode
				if cs.State.Terminated.Message != "" {
					status.Message = cs.State.Terminated.Message
				} else if cs.State.Terminated.Reason != "" {
					status.Message = cs.State.Terminated.Reason
				}
			}
		}
	}
	return status
}
