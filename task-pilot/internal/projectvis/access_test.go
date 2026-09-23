package projectvis_test

import (
	"testing"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// 独立包：避开 service 包内既有破损测试无法编译的问题。
func TestProjectVisibilityAccess(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:proj_vis?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Project{}, &model.ProjectMember{}); err != nil {
		t.Fatal(err)
	}
	s := service.NewProjectService(db)

	owner := &model.User{ID: "u-owner", Username: "owner", Role: model.RoleViewer, Status: model.UserActive}
	other := &model.User{ID: "u-other", Username: "other", Role: model.RoleViewer, Status: model.UserActive}
	if err := db.Create(owner).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(other).Error; err != nil {
		t.Fatal(err)
	}

	priv, err := s.Create(owner, service.CreateProjectInput{Name: "priv-space"})
	if err != nil {
		t.Fatal(err)
	}
	if priv.Visibility != model.ProjectVisibilityPrivate {
		t.Fatalf("new project want private, got %q", priv.Visibility)
	}

	pub, err := s.Create(owner, service.CreateProjectInput{Name: "pub-space", Visibility: model.ProjectVisibilityPublic})
	if err != nil {
		t.Fatal(err)
	}

	guestPriv, err := s.ResolveAccess(nil, priv.ID)
	if err != nil || guestPriv.CanRead() {
		t.Fatalf("guest must not read private: %+v %v", guestPriv, err)
	}
	guestPub, err := s.ResolveAccess(nil, pub.ID)
	if err != nil || !guestPub.CanRead() || guestPub.CanWrite() {
		t.Fatalf("guest read-only on public: %+v %v", guestPub, err)
	}

	otherPriv, err := s.ResolveAccess(other, priv.ID)
	if err != nil || otherPriv.CanRead() {
		t.Fatalf("non-member must not read private: %+v %v", otherPriv, err)
	}

	if _, err := s.AddMember(priv.ID, other.ID, model.ProjectRoleViewer); err != nil {
		t.Fatal(err)
	}
	shared, err := s.ResolveAccess(other, priv.ID)
	if err != nil || !shared.CanRead() || shared.CanWrite() {
		t.Fatalf("shared viewer read-only: %+v %v", shared, err)
	}

	uid, err := s.ResolveUserID("", "other")
	if err != nil || uid != other.ID {
		t.Fatalf("ResolveUserID: %q %v", uid, err)
	}

	vis, err := s.ListVisible(other)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, p := range vis {
		ids[p.ID] = true
	}
	if !ids[priv.ID] || !ids[pub.ID] {
		t.Fatalf("other should see shared private + public, got %v", ids)
	}
	guestList, err := s.ListVisible(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range guestList {
		if p.ID == priv.ID {
			t.Fatal("guest must not list private")
		}
	}
}

func TestCreatorMemberGuards(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:proj_guard?mode=memory&cache=shared"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.Project{}, &model.ProjectMember{}); err != nil {
		t.Fatal(err)
	}
	s := service.NewProjectService(db)

	creator := &model.User{ID: "u-c", Username: "creator", Role: model.RoleViewer, Status: model.UserActive}
	mgr := &model.User{ID: "u-m", Username: "manager", Role: model.RoleViewer, Status: model.UserActive}
	viewer := &model.User{ID: "u-v", Username: "viewer1", Role: model.RoleViewer, Status: model.UserActive}
	for _, u := range []*model.User{creator, mgr, viewer} {
		if err := db.Create(u).Error; err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.Create(creator, service.CreateProjectInput{Name: "guarded"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMember(p.ID, mgr.ID, model.ProjectRoleOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMember(p.ID, viewer.ID, model.ProjectRoleViewer); err != nil {
		t.Fatal(err)
	}

	if err := s.AssertCanChangeMemberRole(mgr, p.ID, creator.ID); err == nil {
		t.Fatal("shared manager must not change creator role")
	}
	if err := s.AssertCanChangeMemberRole(mgr, p.ID, mgr.ID); err == nil {
		t.Fatal("shared manager must not change own role")
	}
	if err := s.AssertCanRemoveMember(mgr, p.ID, creator.ID); err == nil {
		t.Fatal("shared manager must not remove creator")
	}
	if err := s.AssertCanRemoveMember(mgr, p.ID, mgr.ID); err == nil {
		t.Fatal("shared manager must not remove another owner")
	}
	if err := s.AssertCanRemoveMember(mgr, p.ID, viewer.ID); err != nil {
		t.Fatalf("shared manager should remove viewer: %v", err)
	}
	if err := s.AssertCanRemoveMember(creator, p.ID, mgr.ID); err != nil {
		t.Fatalf("creator should remove manager: %v", err)
	}
	if err := s.AssertCanRemoveMember(creator, p.ID, creator.ID); err == nil {
		t.Fatal("creator must not remove themselves")
	}
}
