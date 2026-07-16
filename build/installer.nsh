!include "LogicLib.nsh"
!include "nsProcess.nsh"

!macro customCheckAppRunning
  switcher_check_running:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Codex Account Switcher 正在运行。点击“确定”关闭程序并继续安装，或点击“取消”退出安装。" /SD IDOK IDOK switcher_close_running
      Quit
    ${EndIf}

    switcher_close_running:
    DetailPrint "正在关闭 Codex Account Switcher..."
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-install'
      Sleep 1500
    ${EndIf}

    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      DetailPrint "正在结束仍在运行的程序进程..."
      nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      Pop $R1
      Sleep 1500
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${EndIf}

    ${If} $R0 == 0
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R1
      Sleep 1200
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "安装程序无法自动关闭 Codex Account Switcher。点击“重试”再次自动关闭，或点击“取消”退出安装。" /SD IDCANCEL IDRETRY switcher_check_running
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\aa\*.*"
    DetailPrint "正在暂存 aa 托管凭证库..."
    CreateDirectory "$PLUGINSDIR\old-install\aa"
    CopyFiles /SILENT "$INSTDIR\aa\*.*" "$PLUGINSDIR\old-install\aa"
  ${EndIf}
  ${nsProcess::Unload}
!macroend

!macro customInstall
  ${If} ${FileExists} "$PLUGINSDIR\old-install\aa\*.*"
    DetailPrint "正在恢复 aa 托管凭证库..."
    CreateDirectory "$INSTDIR\aa"
    CopyFiles /SILENT "$PLUGINSDIR\old-install\aa\*.*" "$INSTDIR\aa"
  ${EndIf}
!macroend
