# send-ctrlc.ps1 -- deliver CTRL_C_EVENT to another process's console.
#
# Why this exists: Node.js on Windows has NO way to deliver a console control
# event. `child.kill('SIGINT')` is compiled to TerminateProcess() by libuv, and
# libuv maps it to TerminateProcess, so the target gets no chance to clean up.
#
# Requirements for this to work (verified on this machine, see docs/ENVIRONMENT.md):
#   * the target MUST have its own console. Spawning the child with
#     `windowsHide: true` makes libuv pass CREATE_NO_WINDOW, which creates a
#     HIDDEN console -- invisible to the user, but attachable.
#     (`detached: true` uses DETACHED_PROCESS, i.e. NO console -- then
#      AttachConsole fails with ERROR_INVALID_HANDLE (6).)
#   * we must ignore Ctrl+C for OURSELVES before broadcasting, otherwise this
#     PowerShell process dies together with the target.
#
# Exit codes: 0 = event delivered, 2 = could not attach, 3 = could not send,
#             4 = bad arguments, 5 = REFUSED (console not exclusively ours)
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [int]$TimeoutMs = 500
)

$ErrorActionPreference = 'Stop'

# Emit UTF-8 so the Node side decodes our diagnostics correctly on non-English
# Windows (the default console encoding is GBK on this machine).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if ($TargetPid -le 0) {
    [Console]::Error.WriteLine('send-ctrlc: invalid -TargetPid')
    exit 4
}

Add-Type -Namespace DshLlama -Name Native -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool FreeConsole();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool AttachConsole(uint dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern uint GetConsoleProcessList(uint[] lpdwProcessList, uint dwProcessCount);
"@

# 1. Ignore CTRL+C for this process. GenerateConsoleCtrlEvent(..., 0) broadcasts
#    to every process attached to the console, including us.
$null = [DshLlama.Native]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)

# 2. Leave our own console (if any) so we can attach to the target's.
$null = [DshLlama.Native]::FreeConsole()

# 3. Attach to the target's (hidden) console.
if (-not [DshLlama.Native]::AttachConsole([uint32]$TargetPid)) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [Console]::Error.WriteLine("send-ctrlc: AttachConsole($TargetPid) failed, win32 error $err")
    exit 2
}

# 4. SAFETY GATE -- never broadcast into a console we do not exclusively own.
#
#    GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) signals EVERY process attached
#    to the console, not just the target. If the child ever inherited a shared
#    console (i.e. the parent's, e.g. DSH's own), this call would deliver
#    Ctrl+C to DSH itself. We therefore only proceed when the console holds
#    exactly the target plus ourselves. Anything else is refused (exit 5) and
#    the caller falls back to a targeted forced kill.
$buf = New-Object uint32[] 16
$count = [DshLlama.Native]::GetConsoleProcessList($buf, [uint32]$buf.Length)
if ($count -eq 0) {
    [Console]::Error.WriteLine('send-ctrlc: GetConsoleProcessList returned 0, cannot verify console ownership')
    exit 5
}
$procs = @()
for ($i = 0; $i -lt $count; $i++) { $procs += [int]$buf[$i] }
if (-not ($procs -contains $TargetPid)) {
    [Console]::Error.WriteLine("send-ctrlc: target pid $TargetPid is not attached to the console we reached (saw: $($procs -join ','))")
    exit 5
}
if ($count -gt 2) {
    [Console]::Error.WriteLine("send-ctrlc: refusing to broadcast Ctrl+C -- console is shared by $count processes ($($procs -join ','))")
    exit 5
}

# 5. Broadcast CTRL_C_EVENT to the console's process group.
$ok = [DshLlama.Native]::GenerateConsoleCtrlEvent(0, 0)
if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [Console]::Error.WriteLine("send-ctrlc: GenerateConsoleCtrlEvent failed, win32 error $err")
    exit 3
}

# 6. Stay attached briefly so the event is actually dispatched before we exit.
if ($TimeoutMs -gt 0) { Start-Sleep -Milliseconds $TimeoutMs }

[Console]::Out.WriteLine("send-ctrlc: CTRL_C_EVENT delivered to pid $TargetPid")
exit 0
