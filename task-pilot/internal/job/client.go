package job

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type Client struct {
	clientset kubernetes.Interface
}

func NewClient(kubeconfig string) (*Client, error) {
	cfg, err := kubernetesConfig(kubeconfig)
	if err != nil {
		return nil, err
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Client{clientset: clientset}, nil
}

func kubernetesConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig != "" {
		return clientcmd.BuildConfigFromFlags("", kubeconfig)
	}
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	if env := os.Getenv("KUBECONFIG"); env != "" {
		return clientcmd.BuildConfigFromFlags("", env)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return clientcmd.BuildConfigFromFlags("", filepath.Join(home, ".kube", "config"))
}

func (c *Client) Create(ctx context.Context, job *batchv1.Job) error {
	_, err := c.clientset.BatchV1().Jobs(job.Namespace).Create(ctx, job, metav1.CreateOptions{})
	return err
}

func (c *Client) Delete(ctx context.Context, namespace, name string) error {
	policy := metav1.DeletePropagationForeground
	err := c.clientset.BatchV1().Jobs(namespace).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &policy})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func (c *Client) Status(ctx context.Context, namespace, name, taskID string) (Status, error) {
	jobObj, err := c.clientset.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return Status{}, err
	}
	pod, _ := c.FindPod(ctx, namespace, taskID)
	return FromJobAndPod(jobObj, pod), nil
}

func (c *Client) FindPod(ctx context.Context, namespace, taskID string) (*corev1.Pod, error) {
	selector := labels.Set{"task-id": taskID}.String()
	pods, err := c.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	if len(pods.Items) == 0 {
		return nil, nil
	}
	return &pods.Items[0], nil
}

func (c *Client) Logs(ctx context.Context, namespace, podName string) (string, error) {
	if podName == "" {
		return "", fmt.Errorf("pod name is empty")
	}
	req := c.clientset.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{Container: "executor", TailLines: int64Ptr(200)})
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", err
	}
	defer stream.Close()
	buf, err := io.ReadAll(stream)
	if err != nil {
		return "", err
	}
	return string(buf), nil
}

func int64Ptr(v int64) *int64 {
	return &v
}
