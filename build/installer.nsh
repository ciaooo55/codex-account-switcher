!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
Var /GLOBAL pid

!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "正在关闭 Codex Account Switcher..."
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install'
    Sleep 1500
  ${EndIf}

  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

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
