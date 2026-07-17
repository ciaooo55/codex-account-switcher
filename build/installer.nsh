!include "LogicLib.nsh"

!macro backupManagedLibrary LOCATION
  ${If} ${FileExists} "${LOCATION}\aa\*.*"
    InitPluginsDir
    CreateDirectory "$PLUGINSDIR\old-install\aa"
    CopyFiles /SILENT "${LOCATION}\aa\*.*" "$PLUGINSDIR\old-install\aa"
  ${EndIf}
!macroend

!macro repairInstallRecord ROOT MODE LABEL
  ReadRegStr $5 ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $5 != ""
    StrCpy $0 $5 1 1
    ${If} $0 == "\"
      StrCpy $1 $5 1
      StrCpy $2 $5 "" 1
      StrCpy $3 "$1:$2"
      ${If} ${FileExists} "$3\${APP_EXECUTABLE_FILENAME}"
      ${OrIf} ${FileExists} "$3\${UNINSTALL_FILENAME}"
      ${OrIf} ${FileExists} "$3\aa\*.*"
        DetailPrint "正在修复旧版本遗留的 ${LABEL} 安装路径..."
        StrCpy $5 $3
        WriteRegStr ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation "$5"
      ${EndIf}
    ${EndIf}

    ${If} ${FileExists} "$5\${APP_EXECUTABLE_FILENAME}"
    ${AndIf} ${FileExists} "$5\${UNINSTALL_FILENAME}"
      ReadRegStr $4 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $4 == ""
        DetailPrint "正在恢复缺失的 ${LABEL} 卸载记录..."
        WriteRegStr ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString '"$5\${UNINSTALL_FILENAME}" /${MODE}'
        WriteRegStr ${ROOT} "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString '"$5\${UNINSTALL_FILENAME}" /${MODE} /S'
      ${EndIf}
    ${Else}
      DetailPrint "正在清理旧版本未完成的 ${LABEL} 安装或卸载状态..."
      !insertmacro backupManagedLibrary "$5"
      DeleteRegKey ${ROOT} "${UNINSTALL_REGISTRY_KEY}"
      DeleteRegKey ${ROOT} "${INSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro check64BitAndSetRegView
    !insertmacro repairInstallRecord HKCU currentuser "当前用户"
    !insertmacro repairInstallRecord HKLM allusers "所有用户"
  !endif
!macroend

!macro customInit
  InitPluginsDir
  DetailPrint "正在暂存 aa 托管凭证库..."
  !insertmacro backupManagedLibrary "$INSTDIR"
!macroend

!macro customInstall
  ${If} ${FileExists} "$PLUGINSDIR\old-install\aa\*.*"
    DetailPrint "正在恢复 aa 托管凭证库..."
    CreateDirectory "$INSTDIR\aa"
    CopyFiles /SILENT "$PLUGINSDIR\old-install\aa\*.*" "$INSTDIR\aa"
  ${EndIf}
!macroend
