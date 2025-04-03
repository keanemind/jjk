const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("stdlib.h");
});

fn signalHandler(_: c_int) callconv(.C) void {
    c.exit(0);
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

    // Set up C signal handlers to exit with code 0 on SIGINT or SIGTERM
    _ = c.signal(c.SIGINT, signalHandler);
    _ = c.signal(c.SIGTERM, signalHandler);

    // Keep the program running until a signal is received
    while (true) {
        std.time.sleep(1 * std.time.ns_per_s);
    }
}
