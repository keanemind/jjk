set -e
env GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o ./out/fakeeditor_darwin_arm64
env GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o ./out/fakeeditor_darwin_amd64
env GOOS=linux GOARCH=arm go build -ldflags="-s -w" -o ./out/fakeeditor_linux_arm
env GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ./out/fakeeditor_linux_arm64
env GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ./out/fakeeditor_linux_amd64
env GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o ./out/fakeeditor_windows_arm64.exe
env GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ./out/fakeeditor_windows_amd64.exe
