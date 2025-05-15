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
        var overlapped: c.OVERLAPPED = std.mem.zeroes(c.OVERLAPPED);
        overlapped.hEvent = c.CreateEventA(
            null, // lpEventAttributes
            1, // bManualReset (TRUE)
            0, // bInitialState (FALSE)
            null, // lpName
        );
        // CreateEventA returns NULL on failure.
        if (overlapped.hEvent == null) {
            std.debug.print("Failed to create event: {}\n", .{c.GetLastError()});
            std.process.exit(1);
        }
        defer _ = c.CloseHandle(overlapped.hEvent);

        const hPipe = c.CreateFileA(
            pipePath.ptr,
            c.GENERIC_READ | c.GENERIC_WRITE, // Keep original access mode
            0, // dwShareMode (0 for exclusive access)
            null, // lpSecurityAttributes
            c.OPEN_EXISTING,
            c.FILE_FLAG_OVERLAPPED, // Enable overlapped I/O
            null, // hTemplateFile
        );
        if (hPipe == c.INVALID_HANDLE_VALUE) {
            std.debug.print("Failed to connect to pipe: {}\n", .{c.GetLastError()});
            std.process.exit(1);
        }
        defer _ = c.CloseHandle(hPipe);

        var readBuf: [16]u8 = undefined;
        var bytesRead: c.DWORD = 0;

        // Initiate an overlapped read.
        // For ReadFile with overlapped I/O, the lpNumberOfBytesRead param must be NULL if lpOverlapped is not NULL.
        const read_requested = c.ReadFile(hPipe, &readBuf, readBuf.len, null, &overlapped);

        if (read_requested == 0) { // BOOL is 0 for FALSE
            const last_error = c.GetLastError();
            if (last_error == c.ERROR_IO_PENDING) {
                // Operation is pending, wait for it or timeout
                const wait_timeout_ms: c.DWORD = 5000;
                const wait_status = c.WaitForSingleObject(overlapped.hEvent, wait_timeout_ms);

                if (wait_status == c.WAIT_OBJECT_0) {
                    // Operation completed. Get the result.
                    // bWait = FALSE because WaitForSingleObject already ensured completion.
                    if (c.GetOverlappedResult(hPipe, &overlapped, &bytesRead, 0) == 0) { // WINBOOL FALSE
                        std.debug.print("GetOverlappedResult failed after wait: {}\n", .{c.GetLastError()});
                        std.process.exit(1);
                    }
                    // bytesRead is now populated.
                } else if (wait_status == c.WAIT_TIMEOUT) {
                    std.debug.print("Timeout waiting for EXIT command on pipe (Windows)\n", .{});
                    // Attempt to cancel the pending I/O operation.
                    _ = c.CancelIoEx(hPipe, &overlapped);
                    std.process.exit(1);
                } else { // WAIT_FAILED or other unexpected status
                    std.debug.print("WaitForSingleObject failed: {}\n", .{c.GetLastError()});
                    std.process.exit(1);
                }
            } else {
                // ReadFile failed immediately for a reason other than ERROR_IO_PENDING.
                std.debug.print("ReadFile failed immediately: {}\n", .{last_error});
                std.process.exit(1);
            }
        } else {
            // ReadFile completed synchronously. Get the result.
            // bWait = FALSE as it completed synchronously.
            if (c.GetOverlappedResult(hPipe, &overlapped, &bytesRead, 0) == 0) { // WINBOOL FALSE
                std.debug.print("GetOverlappedResult failed after synchronous read: {}\n", .{c.GetLastError()});
                std.process.exit(1);
            }
            // bytesRead is now populated.
        }

        // At this point, if we haven't exited, the read operation (if successful) has completed.
        // Check if any bytes were read and if it's the EXIT command.
        if (bytesRead > 0) {
            const cmd = readBuf[0..bytesRead];
            if (std.mem.eql(u8, cmd, "EXIT\n")) {
                std.process.exit(0);
            } else {
                std.debug.print("Received non-EXIT command: {s} (Windows)\n", .{cmd});
                std.process.exit(1);
            }
        } else {
            // Read 0 bytes (e.g., pipe closed by writer before EXIT was sent, or other issues).
            // Timeout case is handled above. This handles successful read of zero bytes.
            std.debug.print("Read 0 bytes or pipe closed before EXIT (Windows)\n", .{});
            std.process.exit(1);
        }
    } else {
        // On Unix, open the pipe for reading
        const file = std.fs.cwd().openFile(pipePath, .{ .mode = .read_only }) catch |err| {
            std.debug.print("Failed to open pipe: {}\n", .{err});
            std.process.exit(1);
        };
        defer file.close();

        // Get the file descriptor for polling
        const fd = file.handle;

        var poll_fds = [_]std.posix.pollfd{
            .{
                .fd = fd,
                .events = std.posix.POLL.IN,
                .revents = 0,
            },
        };

        // Poll for 5 seconds (5000 milliseconds)
        const poll_timeout_ms: i32 = 5000;
        const num_events = std.posix.poll(&poll_fds, poll_timeout_ms) catch |err| {
            std.debug.print("Failed to poll pipe (std.posix.poll): {}\n", .{err});
            std.process.exit(1);
        };

        if (num_events == 0) {
            // Timeout occurred
            std.debug.print("Timeout waiting for EXIT command on pipe (Unix)\n", .{});
            std.process.exit(1);
        }

        // Check if our file descriptor has input events
        if (poll_fds[0].revents & std.posix.POLL.IN != 0) {
            var readBuf: [16]u8 = undefined;
            const bytesRead = file.read(&readBuf) catch |err| {
                std.debug.print("Failed to read from pipe: {}\n", .{err});
                std.process.exit(1);
            };

            if (bytesRead > 0) {
                const cmd = readBuf[0..bytesRead];
                if (std.mem.eql(u8, cmd, "EXIT\n")) {
                    std.process.exit(0);
                } else {
                    std.debug.print("Received non-EXIT command: {s} (Unix)\n", .{cmd});
                    std.process.exit(1);
                }
            } else {
                // Read 0 bytes (e.g., pipe closed by writer).
                std.debug.print("Read 0 bytes or pipe closed before EXIT (Unix)\n", .{});
                std.process.exit(1);
            }
        } else {
            // Poll returned > 0, but not for POLLIN, or an error/hangup occurred on the fd.
            if (poll_fds[0].revents & std.posix.POLL.ERR != 0 or
                poll_fds[0].revents & std.posix.POLL.HUP != 0 or
                poll_fds[0].revents & std.posix.POLL.NVAL != 0)
            {
                std.debug.print("Pipe error, hangup, or invalid fd during poll (Unix)\n", .{});
            } else {
                std.debug.print("Poll returned ready, but not for input (Unix), revents: {}\n", .{poll_fds[0].revents});
            }
            std.process.exit(1);
        }
    }

    // If control flow reaches here, it means an unexpected state or an unhandled case.
    // All expected paths (success, timeout, error, non-EXIT command) should exit above.
    std.debug.print("Reached end of main unexpectedly.\n", .{});
    std.process.exit(1);
}
