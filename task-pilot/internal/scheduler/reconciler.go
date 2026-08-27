package scheduler

import (
	"context"
	"log"
	"time"
)

// ReconcileFunc 单次同步动作。多个来源（Task、EvalRun）各注册一个。
type ReconcileFunc func(ctx context.Context) error

// Reconciler 周期性触发一组同步动作。
type Reconciler struct {
	interval time.Duration
	funcs    []namedFunc
}

type namedFunc struct {
	name string
	fn   ReconcileFunc
}

func NewReconciler(interval time.Duration) *Reconciler {
	return &Reconciler{interval: interval}
}

// Register 注册一个命名的同步动作。
func (r *Reconciler) Register(name string, fn ReconcileFunc) *Reconciler {
	r.funcs = append(r.funcs, namedFunc{name: name, fn: fn})
	return r
}

func (r *Reconciler) Start(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, nf := range r.funcs {
				if err := nf.fn(ctx); err != nil {
					log.Printf("reconcile %s failed: %v", nf.name, err)
				}
			}
		}
	}
}
