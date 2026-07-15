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
    ${nsProcess::CloseProcess} "${APP_EXECUTABLE_FILENAME}" $R1
    Sleep 1200
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R1
      Sleep 800
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 == 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法关闭 Codex Account Switcher。请手动关闭后点击“重试”。" /SD IDCANCEL IDRETRY switcher_check_running
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${nsProcess::Unload}
!macroend
