Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "LogicLib.nsh"

Name "Clarin Offline Web"
OutFile "${OUTPUT_FILE}"
InstallDir "$PROGRAMFILES64\Clarin\OfflineV3"
RequestExecutionLevel admin
CRCCheck force
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Clarin Offline Web"
VIAddVersionKey /LANG=1033 "FileDescription" "Motor local para Clarin web"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Clarin"
!define MUI_CUSTOMFUNCTION_ABORT CleanupSecureStageOnAbort
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Var SecureStageDir

!macro HardenInstalledPayload PayloadPath
  ExecWait '"$SYSDIR\icacls.exe" "${PayloadPath}" /setowner *S-1-5-32-544 /Q' $0
  StrCmp $0 0 +2
  Goto installed_payload_hardening_failed
  ExecWait '"$SYSDIR\icacls.exe" "${PayloadPath}" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *S-1-5-32-545:RX /Q' $0
  StrCmp $0 0 +2
  Goto installed_payload_hardening_failed
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Clarin Offline requiere Windows 11 x64."
    Abort
  ${EndIf}
  SetRegView 64
  StrCmp $INSTDIR "$PROGRAMFILES64\Clarin\OfflineV3" install_path_ok
  MessageBox MB_ICONSTOP "La ruta de instalación de Clarin Offline es fija por seguridad."
  Abort
  install_path_ok:
FunctionEnd

Function un.onInit
  SetRegView 64
  StrCmp $INSTDIR "$PROGRAMFILES64\Clarin\OfflineV3" uninstall_path_ok
  MessageBox MB_ICONSTOP "La ruta de desinstalación de Clarin Offline no es válida."
  Abort
  uninstall_path_ok:
FunctionEnd

Function CreateSecureStage
  StrCpy $SecureStageDir ""
  System::Call 'ole32::CoCreateGuid(g .s)'
  Pop $0
  StrCmp $0 "" secure_stage_failed
  StrCpy $SecureStageDir "$COMMONFILES64\ClarinOfflineV3-$0"
  IfFileExists "$SecureStageDir" secure_stage_failed
  ClearErrors
  CreateDirectory "$SecureStageDir"
  IfErrors secure_stage_failed
  ExecWait '"$SYSDIR\icacls.exe" "$SecureStageDir" /setowner *S-1-5-32-544 /Q' $1
  StrCmp $1 0 +2
  Goto secure_stage_failed
  ExecWait '"$SYSDIR\icacls.exe" "$SecureStageDir" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /Q' $1
  StrCmp $1 0 +2
  Goto secure_stage_failed
  Push 0
  Return

  secure_stage_failed:
  StrCmp $SecureStageDir "" secure_stage_failed_done
  SetOutPath "$WINDIR"
  Delete "$SecureStageDir\configure-service.ps1"
  RMDir "$SecureStageDir"
  secure_stage_failed_done:
  StrCpy $SecureStageDir ""
  Push 1
FunctionEnd

Function RemoveSecureStage
  StrCmp $SecureStageDir "" secure_stage_removed
  SetOutPath "$WINDIR"
  Delete "$SecureStageDir\configure-service.ps1"
  RMDir "$SecureStageDir"
  IfFileExists "$SecureStageDir" secure_stage_cleanup_failed
  StrCpy $SecureStageDir ""
  secure_stage_removed:
  Push 0
  Return

  secure_stage_cleanup_failed:
  Push 1
FunctionEnd

Function CleanupSecureStageOnAbort
  Call RemoveSecureStage
  Pop $0
FunctionEnd

Function .onGUIEnd
  Call RemoveSecureStage
  Pop $0
FunctionEnd

Section "Motor local"
  Call CreateSecureStage
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo crear un área segura para instalar Clarin Offline."
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$SecureStageDir"
  File "/source/configure-service.ps1"
  ExecWait '"$SYSDIR\icacls.exe" "$SecureStageDir\configure-service.ps1" /setowner *S-1-5-32-544 /Q' $0
  ${If} $0 == 0
    ExecWait '"$SYSDIR\icacls.exe" "$SecureStageDir\configure-service.ps1" /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F /Q' $0
  ${EndIf}
  ${If} $0 != 0
    Call RemoveSecureStage
    Pop $1
    MessageBox MB_ICONSTOP "No se pudo proteger el área temporal del instalador."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$SecureStageDir\configure-service.ps1" -Action Prepare' $0
  Call RemoveSecureStage
  Pop $1
  ${If} $1 != 0
    MessageBox MB_ICONSTOP "No se pudo limpiar el área segura del instalador."
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo preparar el servicio. No se han borrado los datos locales."
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  File "${INPUT_DIR}/clarin-offline-service.exe"
  File "${INPUT_DIR}/clarin-offline-principal.exe"
  File "/source/configure-service.ps1"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  !insertmacro HardenInstalledPayload "$INSTDIR\clarin-offline-service.exe"
  !insertmacro HardenInstalledPayload "$INSTDIR\clarin-offline-principal.exe"
  !insertmacro HardenInstalledPayload "$INSTDIR\configure-service.ps1"
  !insertmacro HardenInstalledPayload "$INSTDIR\Uninstall.exe"
  Goto installed_payload_hardening_complete
  installed_payload_hardening_failed:
  MessageBox MB_ICONSTOP "No se pudieron proteger los archivos instalados."
  SetErrorLevel 1
  Abort
  installed_payload_hardening_complete:
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\configure-service.ps1" -Action Configure' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "El motor no superó la comprobación de inicio. Los datos se conservan; no habilites offline hasta resolverlo."
    SetErrorLevel 1
    Abort
  ${EndIf}
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3" "DisplayName" "Clarin Offline Web"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\configure-service.ps1" -Action Uninstall' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo detener el motor. La desinstalación se ha detenido para conservar los datos."
    Abort
  ${EndIf}
  Delete "$INSTDIR\clarin-offline-service.exe"
  Delete "$INSTDIR\clarin-offline-principal.exe"
  Delete "$INSTDIR\configure-service.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ClarinOfflineV3"
  MessageBox MB_OK "Se quitó el motor. La copia cifrada y los cambios pendientes se conservaron en ProgramData para recuperación."
SectionEnd
