const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("stdlib.h");
    // For getppid / kill on POSIX
    if (builtin.os.tag != .windows) {
        @cInclude("unistd.h"); // For getppid
        @cInclude("signal.h"); // For kill
    }
    // Windows-specific includes
    if (builtin.os.tag == .windows) {
        @cInclude("windows.h");
        @cInclude("tlhelp32.h"); // For CreateToolhelp32Snapshot
    }
});

const POLLING_INTERVAL_MS: u64 = 50;
const TOTAL_TIMEOUT_MS: u64 = 5000;

fn flushAndExit(stdout: *std.Io.Writer, stderr: *std.Io.Writer, code: u8) noreturn {
    stdout.flush() catch {};
    stderr.flush() catch {};
    std.process.exit(code);
}

// Helper function to check if a process exists on Windows
fn parentProcessExistsWindows(parent_pid: c.DWORD, stderr: *std.Io.Writer) !bool {
    const hParentProcess = c.OpenProcess(c.SYNCHRONIZE, 0, parent_pid);
    if (hParentProcess == null) {
        // If we can't open the process, it might have already exited or we lack permissions.
        // For our purpose, if OpenProcess fails, we assume the parent is gone or inaccessible.
        return false;
    }
    defer _ = c.CloseHandle(hParentProcess);

    // Check if the parent process object is signaled (i.e., terminated)
    // WaitForSingleObject with 0 timeout is a non-blocking check.
    const wait_status = c.WaitForSingleObject(hParentProcess, 0);
    if (wait_status == c.WAIT_OBJECT_0) {
        return false; // Parent process terminated
    } else if (wait_status == c.WAIT_TIMEOUT) {
        return true; // Parent process still running
    } else {
        // WAIT_FAILED or other error
        try stderr.print("WaitForSingleObject failed: {}\n", .{c.GetLastError()});
        return false; // Assume parent is gone on error
    }
}

// Helper function to get parent PID on Windows
fn getParentPidWindows(stderr: *std.Io.Writer) !c.DWORD {
    const current_pid = c.GetCurrentProcessId();
    const hSnapshot = c.CreateToolhelp32Snapshot(c.TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == c.INVALID_HANDLE_VALUE) {
        try stderr.print("CreateToolhelp32Snapshot failed: {}\n", .{c.GetLastError()});
        return error.SnapshotFailed;
    }
    defer _ = c.CloseHandle(hSnapshot);

    var pe32: c.PROCESSENTRY32 = undefined;
    pe32.dwSize = @sizeOf(c.PROCESSENTRY32);

    if (c.Process32First(hSnapshot, &pe32) == 0) { // BOOL is 0 for FALSE
        try stderr.print("Process32First failed: {}\n", .{c.GetLastError()});
        return error.Process32FirstFailed;
    }

    while (true) {
        if (pe32.th32ProcessID == current_pid) {
            if (pe32.th32ParentProcessID == 0) {
                try stderr.print("Error: Retrieved parent PID is 0 for process {}. This is unexpected.\n", .{current_pid});
                return error.ParentIsSystemIdleProcess;
            }
            return pe32.th32ParentProcessID;
        }
        if (c.Process32Next(hSnapshot, &pe32) == 0) { // BOOL is 0 for FALSE
            if (c.GetLastError() == c.ERROR_NO_MORE_FILES) {
                break; // Reached end of process list
            }
            try stderr.print("Process32Next failed: {}\n", .{c.GetLastError()});
            return error.Process32NextFailed;
        }
    }
    return error.ParentNotFound;
}

pub fn main() !void {
    var stdout_buffer: [1024]u8 = undefined;
    var stderr_buffer: [1024]u8 = undefined;
    var stdout_writer = std.fs.File.stdout().writer(stdout_buffer[0..]);
    var stderr_writer = std.fs.File.stderr().writer(stderr_buffer[0..]);
    const stdout = &stdout_writer.interface;
    const stderr = &stderr_writer.interface;
    const allocator = std.heap.page_allocator;

    const pid = switch (builtin.os.tag) {
        .linux => std.os.linux.getpid(),
        .windows => c.GetCurrentProcessId(),
        .macos, .freebsd, .netbsd, .openbsd, .dragonfly => c.getpid(),
        else => @compileError("Unsupported OS"),
    };
    try stdout.print("{}\n", .{pid});

    var cwd_buffer: [4096]u8 = undefined;
    const cwd = try std.posix.getcwd(&cwd_buffer);
    try stdout.print("{s}\n", .{cwd});

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    for (args) |arg| {
        try stdout.print("{s}\n", .{arg});
    }

    const envVarName = "JJ_FAKEEDITOR_SIGNAL_DIR";
    const signal_dir_path_owned = std.process.getEnvVarOwned(allocator, envVarName) catch |err| {
        try stderr.print("Error getting environment variable '{s}': {any}\n", .{ envVarName, err });
        flushAndExit(stdout, stderr, 1);
    };
    defer allocator.free(signal_dir_path_owned);

    try stdout.print("FAKEEDITOR_OUTPUT_END\n", .{});
    try stdout.flush();

    const start_time = std.time.nanoTimestamp();

    const signal_file_path = std.fs.path.join(allocator, &.{ signal_dir_path_owned, "0" }) catch |e| {
        try stderr.print("Critical Error: Failed to construct signal file path '{s}{c}{s}': {any}. Exiting fakeeditor.\n", .{ signal_dir_path_owned, std.fs.path.sep, "0", e });
        flushAndExit(stdout, stderr, 1);
    };

    var ppid: if (builtin.os.tag != .windows) c.pid_t else void =
        if (builtin.os.tag != .windows) 0 else {};
    var win_ppid: if (builtin.os.tag == .windows) c.DWORD else void =
        if (builtin.os.tag == .windows) 0 else {};
    var parent_monitoring_active: bool = true;

    if (builtin.os.tag == .windows) {
        win_ppid = getParentPidWindows(stderr) catch |err| blk: {
            try stderr.print("Warning: Failed to get parent PID on Windows: {any}. Parent process monitoring will be disabled.\n", .{err});
            parent_monitoring_active = false;
            break :blk 0;
        };
    } else {
        ppid = c.getppid();
        if (ppid == 1) { // Reparented to init/launchd
            try stderr.print("Info: Parent process is init/launchd (PID 1), original parent likely exited. Exiting fakeeditor.\n", .{});
            flushAndExit(stdout, stderr, 1); // Exit immediately if reparented
        }
    }

    while (true) {
        const current_time = std.time.nanoTimestamp();
        const elapsed_ms = @divTrunc((current_time - start_time), std.time.ns_per_ms);

        if (elapsed_ms >= TOTAL_TIMEOUT_MS) {
            try stderr.print("Error: Timeout ({}ms) reached in fakeeditor. Exiting.\n", .{TOTAL_TIMEOUT_MS});
            flushAndExit(stdout, stderr, 1);
        }

        // Parent Process Check
        if (parent_monitoring_active) {
            if (builtin.os.tag == .windows) {
                if (!try parentProcessExistsWindows(win_ppid, stderr)) {
                    try stderr.print("Parent process (PID: {}) no longer exists (Windows). Exiting.\n", .{win_ppid});
                    flushAndExit(stdout, stderr, 1);
                }
            } else {
                if (std.posix.kill(ppid, 0)) |_| {
                    // kill succeeded, parent process still exists
                } else |err| {
                    if (err == error.NoSuchProcess) {
                        try stderr.print("Parent process (PID: {}) no longer exists (POSIX). Exiting.\n", .{ppid});
                        flushAndExit(stdout, stderr, 1);
                    }
                    // Other errors with kill could also indicate an issue, but NoSuchProcess is the key one.
                    // If kill fails for other reasons, we might want to log it to stderr but not necessarily exit immediately,
                    // relying on the main timeout or signal file.
                }
            }
        }

        // Check for signal file "0"
        if (std.fs.accessAbsolute(signal_file_path, .{})) |_| {
            // File "0" exists
            flushAndExit(stdout, stderr, 0);
        } else |err| {
            if (err != error.FileNotFound) {
                // Some other error accessing the file, log it but continue polling
                try stderr.print("Error checking for signal file '0' in fakeeditor: {any}\n", .{err});
            }
        }

        std.Thread.sleep(POLLING_INTERVAL_MS * std.time.ns_per_ms);
    }
}
