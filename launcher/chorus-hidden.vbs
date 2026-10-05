' Chorus — hidden launcher.
'
' Run by wscript.exe at Windows sign-in (and by the "Start in background"
' shortcut). wscript is a GUI host, so no console window appears.
'
' It starts the tray helper, which in turn starts the Node server as a hidden
' child process. The tray helper holds the NotifyIcon and keeps running.

Option Explicit

Dim fso, shell, scriptDir, trayScript, powershell, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Resolve paths relative to this script so the entry survives folder moves only
' if the registry value is refreshed; the server reports a stale entry when not.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
trayScript = fso.BuildPath(scriptDir, "chorus-tray.ps1")

If Not fso.FileExists(trayScript) Then
  MsgBox "Chorus could not find its tray helper:" & vbCrLf & trayScript, 16, "Chorus"
  WScript.Quit 1
End If

' Prefer the in-box Windows PowerShell 5.1: it is present on every Windows 10/11
' install and always ships WinForms, which the tray icon needs.
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not fso.FileExists(powershell) Then
  powershell = "powershell.exe"
End If

command = """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """"
shell.Run command, 0, False
