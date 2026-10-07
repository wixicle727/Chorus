; Chorus installer (Inno Setup).
;
; Built by tools/build/build-installer.mjs, which passes in the version, the folder
; holding Chorus.exe, and where to write the output. Compiling this by hand works too:
;
;   "node_modules\innosetup-compiler\bin\ISCC.exe" /DAppVersion=1.2.0 ^
;       /DSourceDir=build\Chorus /DOutputDir=build tools\build\chorus.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "build\Chorus"
#endif
#ifndef OutputDir
  #define OutputDir "build"
#endif

; AppId is what makes an upgrade replace the previous install instead of stacking a
; second copy. It must never change once released.
#define AppId "{{8F3C1D42-9A71-4E6B-B2C5-7D0E4A19F3B8}"
#define AppName "Chorus"
#define AppPublisher "Chorus contributors"
#define AppUrl "https://github.com/wixicle727/Chorus"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases

; Per-user install by default so no administrator rights are needed. The user can still
; choose "install for all users" from the dialog, which elevates.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes

OutputDir={#OutputDir}
OutputBaseFilename=Chorus-{#AppVersion}-Setup
SetupIconFile={#SourceDir}\..\..\assets\chorus.ico
UninstallDisplayIcon={app}\Chorus.exe
UninstallDisplayName={#AppName} {#AppVersion}

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; The app is running-not-running aware: Setup asks the user to close it if it is.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "startup"; Description: "Start Chorus when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; One self-contained executable. The front-end, the logo and the SMTC bridge's scripts
; are embedded in it, so this is the only file the application needs.
Source: "{#SourceDir}\Chorus.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; No parameters: the executable shows the tray icon by default, which is what a
; Start Menu entry should do.
Name: "{group}\{#AppName}"; Filename: "{app}\Chorus.exe"; WorkingDir: "{app}"; Comment: "Live lyrics for OBS"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Chorus.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
; Auto-start, only when the task was ticked. HKCU so it matches what the app's own
; "Start with Windows" toggle writes and needs no elevation.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "Chorus"; ValueData: """{app}\Chorus.exe"""; \
  Flags: uninsdeletevalue; Tasks: startup

[Run]
Description: "Start Chorus now"; Filename: "{app}\Chorus.exe"; WorkingDir: "{app}"; \
  Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop a running instance first, or the executable stays locked and the uninstall leaves
; files behind. The app's own endpoint is the clean way to ask.
Filename: "{app}\Chorus.exe"; Parameters: "--quit"; Flags: runhidden; \
  RunOnceId: "StopChorus"

[UninstallDelete]
; Settings, cache and history live in {app}\data.
;
; NOT listed here, deliberately. Inno Setup only removes {app}\data automatically when
; the directory is empty, so listing it would delete the user's settings, lyric cache and
; history on every uninstall AND every upgrade. They are removed only when the user
; explicitly says so, via the prompt below.

[Code]
// Ask before discarding data, so an uninstall is not silently destructive. An upgrade
// never reaches this: Inno Setup only runs [Code] during an uninstall, and only after the
// user has confirmed they want to remove the application.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{app}\data');
    if DirExists(DataDir) then
    begin
      if MsgBox('Also delete your Chorus settings, lyric cache and history?' + #13#10 + #13#10 +
                DataDir, mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(DataDir, True, True, True);
      end;
    end;
  end;
end;
