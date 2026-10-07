' Chorus built-in SMTC bridge - hidden launcher.
'
' Run by wscript.exe at Windows sign-in, or from a shortcut. wscript is a GUI
' host, so no console window appears and the bridge runs invisibly in the
' background.
'
' Kept separate from launcher\chorus-hidden.vbs on purpose: the bridge is an
' optional, standalone companion to Chorus, so either one can be started or
' removed without disturbing the other.

Option Explicit

Dim fso, shell, scriptDir, serverScript, powershell, command, port

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverScript = fso.BuildPath(scriptDir, "server.ps1")

If Not fso.FileExists(serverScript) Then
  MsgBox "Chorus SMTC bridge could not find its server script:" & vbCrLf & serverScript, 16, "Chorus SMTC bridge"
  WScript.Quit 1
End If

' The port is passed as the first argument and is also made available through an
' environment variable, so the registration can be changed without editing this
' file.
port = ""
If WScript.Arguments.Count > 0 Then
  port = Trim(WScript.Arguments(0))
End If
If port = "" Then
  port = Trim(shell.ExpandEnvironmentStrings("%CHORUS_BRIDGE_PORT%"))
End If
If port = "" Or port = "%CHORUS_BRIDGE_PORT%" Then
  port = "5010"
End If

' Prefer the in-box Windows PowerShell 5.1: present on every Windows 10/11 install,
' and the only PowerShell that binds the WinRT projections the bridge needs.
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
If Not fso.FileExists(powershell) Then
  powershell = "powershell.exe"
End If

command = """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass" _
  & " -WindowStyle Hidden -File """ & serverScript & """ -Port " & port & " -Quiet"

shell.Run command, 0, False
