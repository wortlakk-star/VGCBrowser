# ── VGC Browser — apply fingerprint patches to Chromium "VGC Core" ───────────
# Patches the synced Chromium source (D:\chromium\src) so fingerprint values are
# spoofed natively (C++), controlled by launch switches the app passes per
# profile. Idempotent + EOL-safe. Run before build-engine.ps1.
#
#   Switches (passed to the browser, forwarded to renderer):
#     --vgc-hardware-concurrency=<n>
#     --vgc-device-memory=<gb>
#     --vgc-webgl-vendor=<string>
#     --vgc-webgl-renderer=<string>
$ErrorActionPreference = 'Stop'
$src = 'D:\chromium\src'

function LF([string]$s) { return ($s -replace "`r`n", "`n") }

function Apply([string]$rel, [string]$old, [string]$new) {
  $path = Join-Path $src $rel
  if (-not (Test-Path $path)) { Write-Host "MISSING  $rel" -ForegroundColor Red; return }
  $txt = LF ([System.IO.File]::ReadAllText($path))
  $o = LF $old
  $n = LF $new
  if ($txt.Contains($n)) { Write-Host "skip (already patched)  $rel"; return }
  if (-not $txt.Contains($o)) { Write-Host "ANCHOR NOT FOUND  $rel" -ForegroundColor Red; return }
  $txt = $txt.Replace($o, $n)
  [System.IO.File]::WriteAllText($path, $txt, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "patched  $rel" -ForegroundColor Green
}

# ── 1. navigator.hardwareConcurrency ─────────────────────────────────────────
Apply 'third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc' @'
#include "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.h"

#include "base/system/sys_info.h"

namespace blink {

unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());
}
'@ @'
#include "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.h"

#include "base/command_line.h"
#include "base/strings/string_number_conversions.h"
#include "base/system/sys_info.h"

namespace blink {

unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  // VGC Core: spoof navigator.hardwareConcurrency from a launch switch.
  const base::CommandLine* vgc_cmd = base::CommandLine::ForCurrentProcess();
  if (vgc_cmd->HasSwitch("vgc-hardware-concurrency")) {
    unsigned vgc_value = 0;
    if (base::StringToUint(
            vgc_cmd->GetSwitchValueASCII("vgc-hardware-concurrency"),
            &vgc_value) &&
        vgc_value > 0) {
      return vgc_value;
    }
  }
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());
}
'@

# ── 2. navigator.deviceMemory — includes ─────────────────────────────────────
Apply 'third_party/blink/renderer/core/frame/navigator_device_memory.cc' @'
#include "third_party/blink/renderer/core/frame/navigator_device_memory.h"

#include "third_party/blink/public/common/device_memory/approximated_device_memory.h"
'@ @'
#include "third_party/blink/renderer/core/frame/navigator_device_memory.h"

#include "base/command_line.h"
#include "base/strings/string_number_conversions.h"
#include "third_party/blink/public/common/device_memory/approximated_device_memory.h"
'@

# ── 2b. navigator.deviceMemory — body ────────────────────────────────────────
Apply 'third_party/blink/renderer/core/frame/navigator_device_memory.cc' @'
float NavigatorDeviceMemory::deviceMemory() const {
  return ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
}
'@ @'
float NavigatorDeviceMemory::deviceMemory() const {
  // VGC Core: spoof navigator.deviceMemory from a launch switch.
  const base::CommandLine* vgc_cmd = base::CommandLine::ForCurrentProcess();
  if (vgc_cmd->HasSwitch("vgc-device-memory")) {
    double vgc_value = 0;
    if (base::StringToDouble(
            vgc_cmd->GetSwitchValueASCII("vgc-device-memory"), &vgc_value) &&
        vgc_value > 0) {
      return static_cast<float>(vgc_value);
    }
  }
  return ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
}
'@

# ── 3. WebGL include ─────────────────────────────────────────────────────────
Apply 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc' @'
#include "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.h"
'@ @'
#include "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.h"

#include "base/command_line.h"
'@

# ── 3b. WebGL UNMASKED_RENDERER ──────────────────────────────────────────────
Apply 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc' @'
      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {
        return WebGLAny(script_state,
                        String(ContextGL()->GetString(GL_RENDERER)));
      }
'@ @'
      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {
        const base::CommandLine* vgc_cmd =
            base::CommandLine::ForCurrentProcess();
        if (vgc_cmd->HasSwitch("vgc-webgl-renderer")) {
          std::string vgc_r = vgc_cmd->GetSwitchValueASCII("vgc-webgl-renderer");
          return WebGLAny(script_state,
                          String(reinterpret_cast<const LChar*>(vgc_r.c_str())));
        }
        return WebGLAny(script_state,
                        String(ContextGL()->GetString(GL_RENDERER)));
      }
'@

# ── 3c. WebGL UNMASKED_VENDOR ────────────────────────────────────────────────
Apply 'third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc' @'
      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {
        return WebGLAny(script_state,
                        String(ContextGL()->GetString(GL_VENDOR)));
      }
'@ @'
      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {
        const base::CommandLine* vgc_cmd =
            base::CommandLine::ForCurrentProcess();
        if (vgc_cmd->HasSwitch("vgc-webgl-vendor")) {
          std::string vgc_v = vgc_cmd->GetSwitchValueASCII("vgc-webgl-vendor");
          return WebGLAny(script_state,
                          String(reinterpret_cast<const LChar*>(vgc_v.c_str())));
        }
        return WebGLAny(script_state,
                        String(ContextGL()->GetString(GL_VENDOR)));
      }
'@

# ── 4. Forward VGC switches to the renderer process ──────────────────────────
Apply 'content/browser/renderer_host/render_process_host_impl.cc' @'
  static const char* const kSwitchNames[] = {
'@ @'
  static const char* const kSwitchNames[] = {
      // VGC Core fingerprint switches.
      "vgc-hardware-concurrency",
      "vgc-device-memory",
      "vgc-webgl-vendor",
      "vgc-webgl-renderer",
'@

Write-Host "`nVGC patches applied. Next: build-engine.ps1" -ForegroundColor Cyan
