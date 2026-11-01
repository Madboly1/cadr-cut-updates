; =====================================================================
; CADR CUT — Official Windows Installer Script (Inno Setup 6)
; Brand: CADR STUDIO ("YOUR VISION. OUR FRAME.")
; Compatible with Adobe Premiere Pro 2020 through 2026, 2027 & Newer
; Supports In-App One-Click GitHub OTA Auto-Updates (v1.3.2+)
; =====================================================================

#define MyAppName "CADR CUT"
#define MyAppVersion "1.3.2"
#define MyAppPublisher "CADR STUDIO"
#define MyAppURL "https://cadrstudio.com"
#define ExtensionFolderName "CADR_CUT"

[Setup]
AppId={{8F9C4D2A-5B71-4E3A-9C1D-2A6E8B4F1026}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion} — Premiere Pro Plugin (2020 - 2027+)
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={commoncf32}\Adobe\CEP\extensions\{#ExtensionFolderName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
CloseApplications=yes
OutputDir=Output
OutputBaseFilename=CADR_CUT_Setup_v{#MyAppVersion}
SetupIconFile=CADR_CUT_icon_FINAL.ico
UninstallDisplayIcon={app}\CADR_CUT_icon_FINAL.ico
UninstallDisplayName={#MyAppName} (Premiere Pro Plugin)
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=105
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to the {#MyAppName} Setup Wizard
WelcomeLabel2=This will install {#MyAppName} v{#MyAppVersion} by {#MyAppPublisher} for Adobe Premiere Pro (2020 - 2026 / 2027+) on your computer.%n%nYOUR VISION. OUR FRAME.%n%nPlease close Adobe Premiere Pro before continuing.
FinishedHeadingLabel=Completing the {#MyAppName} Setup Wizard
FinishedLabel={#MyAppName} has been installed on your computer.%n%nTo open the plugin inside Adobe Premiere Pro:%nGo to Window -> Extensions -> CADR CUT

[InstallDelete]
; Clean up any old or duplicate extension folders & CEP cache so Premiere Pro always loads the fresh UI
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{commoncf32}\Adobe\CEP\extensions\CADR"
Type: filesandordirs; Name: "{commoncf32}\Adobe\CEP\extensions\CADR_CUT - Copy"
Type: filesandordirs; Name: "{commoncf32}\Adobe\CEP\extensions\com.cadr.panel"
Type: filesandordirs; Name: "{commoncf64}\Adobe\CEP\extensions\CADR_CUT"
Type: filesandordirs; Name: "{commoncf64}\Adobe\CEP\extensions\CADR"
Type: filesandordirs; Name: "{commoncf64}\Adobe\CEP\extensions\com.cadr.panel"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\CADR_CUT"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\CADR"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.cadr.panel"
Type: filesandordirs; Name: "{localappdata}\Temp\cep_cache"

[Dirs]
; Grant standard Windows Users modify permissions so In-App GitHub OTA Auto-Updater can overwrite files without Admin prompts
Name: "{app}"; Permissions: users-modify
Name: "{app}\client"; Permissions: users-modify
Name: "{app}\jsx"; Permissions: users-modify
Name: "{app}\CSXS"; Permissions: users-modify

[Files]
; Single clean installation to {commoncf32}\Adobe\CEP\extensions\CADR_CUT with user-modify permissions for OTA updates
Source: "client\*"; DestDir: "{app}\client"; Flags: ignoreversion recursesubdirs createallsubdirs; Permissions: users-modify; Excludes: "*private_key*,*License_Admin*"
Source: "CSXS\*"; DestDir: "{app}\CSXS"; Flags: ignoreversion recursesubdirs createallsubdirs; Permissions: users-modify
Source: "jsx\*"; DestDir: "{app}\jsx"; Flags: ignoreversion recursesubdirs createallsubdirs; Permissions: users-modify
Source: "version.json"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-modify
Source: ".debug"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-modify
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-modify
Source: "LICENSE_SYSTEM_AR.txt"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-modify
Source: "CADR_CUT_icon_FINAL.ico"; DestDir: "{app}"; Flags: ignoreversion; Permissions: users-modify
Source: "tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist; Permissions: users-modify

[Registry]
; Enable PlayerDebugMode across CSXS 9 through 18 (Premiere Pro 2020 through 2026, 2027 & future releases)
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.14"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.15"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.16"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.17"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.18"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { Automatically close any background CEPHtmlEngine.exe processes so old cached files are unlocked & removed }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CEPHtmlEngine.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
