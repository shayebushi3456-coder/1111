APP=task-pilot

.PHONY: tidy fmt test build run

tidy:
	go mod tidy

fmt:
	gofmt -w cmd internal

test:
	go test ./...

build:
	go build -o bin/$(APP) ./cmd/server

run:
	go run ./cmd/server
