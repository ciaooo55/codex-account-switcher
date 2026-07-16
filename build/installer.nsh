!include "LogicLib.nsh"

!macro customInit
  InitPluginsDir
  ${If} ${FileExists} "$INSTDIR\Codex Account Switcher.exe"
    DetailPrint "正在关闭运行中的 Codex Account Switcher..."
    ExecWait '"$INSTDIR\Codex Account Switcher.exe" --quit-for-install'
    Sleep 1200
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\aa\*.*"
    DetailPrint "正在暂存 aa 托管凭证库..."
    CreateDirectory "$PLUGINSDIR\old-install\aa"
    CopyFiles /SILENT "$INSTDIR\aa\*.*" "$PLUGINSDIR\old-install\aa"
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${FileExists} "$PLUGINSDIR\old-install\aa\*.*"
    DetailPrint "正在恢复 aa 托管凭证库..."
    CreateDirectory "$INSTDIR\aa"
    CopyFiles /SILENT "$PLUGINSDIR\old-install\aa\*.*" "$INSTDIR\aa"
  ${EndIf}
!macroend
