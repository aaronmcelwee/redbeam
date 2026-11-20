; REDBEAM installer hooks (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; Registers REDBEAM as a PDF handler for this user, so it appears in
; Explorer's "Open with" and in Settings > Apps > Default apps, where it can
; be chosen as the default PDF viewer. Windows does not let an installer make
; that choice for the person, and this does not try: it never writes
; `.pdf`'s default value or UserChoice, so Bluebeam (or Edge) stays the
; default until the person picks REDBEAM. See src/open_with.rs.
;
; SHCTX is HKCU here: the installer is per-user (installMode currentUser).

!define REDBEAM_PROGID "REDBEAM.pdf"

!macro NSIS_HOOK_POSTINSTALL
  ; The file type REDBEAM opens PDFs as.
  WriteRegStr SHCTX "Software\Classes\${REDBEAM_PROGID}" "" "PDF Document"
  WriteRegStr SHCTX "Software\Classes\${REDBEAM_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\${REDBEAM_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\${REDBEAM_PROGID}\Application" "ApplicationName" "${PRODUCTNAME}"

  ; Open with: offered for .pdf, without taking the default.
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "${REDBEAM_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".pdf" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; Default apps: REDBEAM's own page, listing what it can open.
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationDescription" "PDF viewer for construction takeoff"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities\FileAssociations" ".pdf" "${REDBEAM_PROGID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${MANUPRODUCTKEY}\Capabilities"

  ; Tell Explorer the associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update runs the old uninstaller first. Removing the ProgID then would
  ; make Windows reset a default the person chose, so only a real uninstall
  ; takes the registration away.
  ${If} $UpdateMode <> 1
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}\Capabilities"
    DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "${REDBEAM_PROGID}"
    DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf\OpenWithProgids"
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
    DeleteRegKey SHCTX "Software\Classes\${REDBEAM_PROGID}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
