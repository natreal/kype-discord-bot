' ===========================================================================
' Starts a PowerShell script with no console window at all, and waits for it.
'
'   wscript.exe //B //NoLogo Run-Hidden.vbs ..\deploy\deploy.ps1 [arguments...]
'
' Why this exists: a scheduled task that runs powershell.exe directly flashes a
' console window on the desktop for a fraction of a second, even with
' -WindowStyle Hidden -- that switch hides the console only after Windows has
' created it. A task that fires every minute therefore flashed a window every
' minute, on top of whatever the user was doing. wscript is a GUI process, so
' nothing is created on screen, and window style 0 keeps the child's console
' hidden from its very first frame.
'
' Run(command, 0, True) waits for the child, so the task stays "Running" while
' the script works and the task's last result is the script's exit code.
'
' Pass the script path RELATIVE TO THIS FILE when you can: schtasks.exe strips
' the quotes around each /TR argument, so an absolute path containing a space
' would be split in two. A relative path is resolved here, against this file.
' ===========================================================================
Option Explicit

Dim shell, here, scriptPath, command, i, exitCode

If WScript.Arguments.Count = 0 Then
  WScript.Echo "usage: wscript.exe Run-Hidden.vbs <script.ps1> [arguments...]"
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")

' Task Scheduler starts every job in C:\Windows\System32, so never rely on the
' working directory: a relative path means "relative to Run-Hidden.vbs".
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
scriptPath = WScript.Arguments(0)
If InStr(scriptPath, ":") = 0 And InStr(scriptPath, "\\") <> 1 Then
  scriptPath = here & scriptPath
End If

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """"

For i = 1 To WScript.Arguments.Count - 1
  command = command & " " & WScript.Arguments(i)
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

