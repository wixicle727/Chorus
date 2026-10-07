' Chorus tray helper launcher.
'
' Starts the tray helper as its own hidden process.
'
' The app launches this through wscript rather than starting PowerShell directly,
' because that is the path that reliably keeps the helper alive: a PowerShell process
' started from Node with detached + ignored stdio was measured to exit immediately, so
' the tray icon never appeared. wscript is a GUI host, so shell.Run(..., 0, False)
' gives the helper a hidden window, no console, and an independent life.
'
' Arguments (all optional, in order):
'   %1  path to chorus-tray.ps1
'   %2  application root, so the helper finds its assets
'   %3  port to show and use

Option Explicit

Dim fso, shell, args, trayScript, appRoot, port, powershell, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count > 0 Then
  trayScript = args(0)
Else
  trayScript = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "chorus-tray.ps1")
End If

If args.Count > 1 Then
  appRoot = args(1)
Else
  appRoot = fso.GetParentFolderName(fso.GetParentFolderName(trayScript))
End If

port = ""
If args.Count > 2 Then
  port = Trim(args(2))
End If

If Not fso.FileExists(trayScript) Then
  MsgBox "Chorus could not find its tray helper:" & vbCrLf & trayScript, 16, "Chorus"
  WScript.Quit 1
End If

' Prefer the in-box Windows PowerShell 5.1: present on every Windows 10/11 install and
' the one that always ships WinForms, which the tray icon needs.
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not fso.FileExists(powershell) Then
  powershell = "powershell.exe"
End If

command = """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass" _
  & " -WindowStyle Hidden -File """ & trayScript & """ -Root """ & appRoot & """ -NoServer"

If port <> "" Then
  command = command & " -Port " & port
End If

' 0 = hidden window, False = do not wait for it to finish.
shell.Run command, 0, False
