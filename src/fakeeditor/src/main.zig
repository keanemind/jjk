const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("stdlib.h");
});

// Exit with 0 on SIGINT (success signal from extension)
fn signalHandlerSIGINT(_: c_int) callconv(.C) void {
    std.process.exit(0);
}

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();

    const pid = switch (builtin.os.tag) {
        .linux => std.os.linux.getpid(),
        .windows => std.os.windows.GetCurrentProcessId(),
        .macos, .freebsd, .netbsd, .openbsd, .dragonfly => std.c.getpid(),
        else => @compileError("Unsupported OS"),
    };
    try stdout.print("{}\n", .{pid});

    const args = try std.process.argsAlloc(std.heap.page_allocator);
    defer std.process.argsFree(std.heap.page_allocator, args);
    
    for (args) |arg| {
        try stdout.print("{s}\n", .{arg});
    }

    _ = c.signal(c.SIGINT, signalHandlerSIGINT);

    // Keep the program running until a signal is received or 5 seconds pass
    var seconds: u32 = 0;
    while (seconds < 5) : (seconds += 1) {
        std.time.sleep(1 * std.time.ns_per_s);
    }
    // If loop finishes, it means no SIGINT/SIGTERM was received; exit with 1 (timeout)
    std.process.exit(1);
}
