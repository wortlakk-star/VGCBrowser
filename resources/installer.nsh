; VGC Browser - custom NSIS tweaks
; Silently close any running instance during (re)install so the user never sees
; the "VGC Browser is running" prompt. taskkill runs hidden via nsExec.
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "VGC Browser.exe" /T'
  Sleep 800
!macroend
