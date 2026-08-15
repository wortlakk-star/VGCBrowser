; VGC Browser - custom NSIS tweaks
; Silently close any running instance during (re)install so the user never sees
; the "VGC Browser is running" prompt. taskkill runs hidden via nsExec.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "VGC Browser.exe" /T'
  Sleep 800
!macroend

; HI was bundled through 2.1.70. Remove its loose executable resources explicitly
; during an in-place upgrade so an old install cannot leave the extension behind.
!macro customInstall
  RMDir /r "$INSTDIR\resources\extensions\HI"
  RMDir "$INSTDIR\resources\extensions"
!macroend
