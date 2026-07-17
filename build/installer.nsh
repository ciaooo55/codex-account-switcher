!include "LogicLib.nsh"

!macro repairLegacyMachineInstallPath
  ${If} $installMode == "all"
    ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    StrCpy $0 $5 1 1
    ${If} $0 == "\"
      StrCpy $1 $5 1
      StrCpy $2 $5 "" 1
      StrCpy $3 "$1:$2"
      StrCpy $0 $INSTDIR 1 1
      ${If} $0 == "\"
        ${If} ${FileExists} "$3\${APP_EXECUTABLE_FILENAME}"
        ${OrIf} ${FileExists} "$3\${UNINSTALL_FILENAME}"
        ${OrIf} ${FileExists} "$3\aa\*.*"
          StrCpy $INSTDIR $3
        ${Else}
          StrCpy $INSTDIR "$PROGRAMFILES\${APP_FILENAME}"
        ${EndIf}
      ${EndIf}
      DetailPrint "正在清理旧版本遗留的错误全用户安装记录..."
      DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
      DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  InitPluginsDir
  !insertmacro repairLegacyMachineInstallPath
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
