set -e
zig build -Doptimize=ReleaseSmall -Dtarget=aarch64-macos --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=x86_64-macos --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=arm-linux --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=aarch64-linux --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=x86_64-linux --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=aarch64-windows --release=small --summary all
zig build -Doptimize=ReleaseSmall -Dtarget=x86_64-windows --release=small --summary all
