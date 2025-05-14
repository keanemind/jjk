const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("signal.h");
    @cInclude("stdlib.h");
    // Windows-specific includes for named pipes
    if (builtin.os.tag == .windows) {
        @cInclude("windows.h");
    }
});

// Keep SIGTERM handler for failure cases
fn signalHandlerSIGTERM(_: c_int) callconv(.C) void {
    std.process.exit(1);
}

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    const allocator = std.heap.page_allocator;

    const pid = switch (builtin.os.tag) {
        .linux => std.os.linux.getpid(),
        .windows => std.os.windows.GetCurrentProcessId(),
        .macos, .freebsd, .netbsd, .openbsd, .dragonfly => std.c.getpid(),
        else => @compileError("Unsupported OS"),
    };
    try stdout.print("{}\n", .{pid});

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    if (args.len < 2) {
        std.debug.print("Error: Named pipe path argument is required\n", .{});
        std.process.exit(1);
    }

    // First argument after executable is pipe path
    const pipePath = args[1];

    for (args) |arg| {
        try stdout.print("{s}\n", .{arg});
    }
    try stdout.print("FAKEEDITOR_OUTPUT_END\n", .{});

    // Set up SIGTERM handler for failure cases
    _ = c.signal(c.SIGTERM, signalHandlerSIGTERM);

    if (builtin.os.tag == .windows) {
        const hPipe = c.CreateFileA(
            pipePath.ptr,
            c.GENERIC_READ | c.GENERIC_WRITE,
            0,
            null,
            c.OPEN_EXISTING,
            0,
            null,
        );
        if (hPipe == c.INVALID_HANDLE_VALUE) {
            std.debug.print("Failed to connect to pipe: {}\n", .{c.GetLastError()});
            std.process.exit(1);
        }
        defer _ = c.CloseHandle(hPipe);

        // Wait for "EXIT" command on the pipe
        var readBuf: [16]u8 = undefined;
        var bytesRead: c.DWORD = undefined;
        _ = c.ReadFile(hPipe, &readBuf, readBuf.len, &bytesRead, null);

        const cmd = readBuf[0..bytesRead];
        if (std.mem.eql(u8, cmd, "EXIT\n")) {
            std.process.exit(0);
        }
    } else {
        // On Unix, open the pipe for reading
        const file = std.fs.cwd().openFile(pipePath, .{ .mode = .read_only }) catch |err| {
            std.debug.print("Failed to open pipe: {}\n", .{err});
            std.process.exit(1);
        };
        defer file.close();

        var readBuf: [16]u8 = undefined;
        const bytesRead = file.read(&readBuf) catch |err| {
            std.debug.print("Failed to read from pipe: {}\n", .{err});
            std.process.exit(1);
        };

        const cmd = readBuf[0..bytesRead];
        if (std.mem.eql(u8, cmd, "EXIT\n")) {
            std.process.exit(0);
        }
    }

    // If we reach here, timeout without receiving EXIT command
    std.process.exit(1);
}
