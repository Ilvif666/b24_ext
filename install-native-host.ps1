param(
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "native-host\Program.cs"
$publishDir = Join-Path $root "native-host\publish"
$hostName = "b24_slicer_launcher"
$hostManifestPath = Join-Path $publishDir "$hostName.json"

function Get-ExistingExtensionId {
  $registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
  if (!(Test-Path -LiteralPath $registryPath)) {
    return $null
  }

  $existingManifestPath = (Get-Item -LiteralPath $registryPath).GetValue("")
  if (!$existingManifestPath -or !(Test-Path -LiteralPath $existingManifestPath)) {
    return $null
  }

  try {
    $existingManifest = Get-Content -Raw -LiteralPath $existingManifestPath | ConvertFrom-Json
    $origin = @($existingManifest.allowed_origins)[0]
    if ($origin -match '^chrome-extension://([^/]+)/$') {
      return $Matches[1]
    }
  } catch {
    return $null
  }

  return $null
}

function Find-ExtensionIdInChromeProfiles {
  $chromeUserData = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
  if (!(Test-Path -LiteralPath $chromeUserData)) {
    return $null
  }

  $normalizedRoot = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
  $preferenceFiles = Get-ChildItem -LiteralPath $chromeUserData -Filter "Preferences" -Recurse -ErrorAction SilentlyContinue

  foreach ($preferenceFile in $preferenceFiles) {
    try {
      $preferences = Get-Content -Raw -LiteralPath $preferenceFile.FullName | ConvertFrom-Json
      $settings = $preferences.extensions.settings
      if (!$settings) {
        continue
      }

      foreach ($property in $settings.PSObject.Properties) {
        $path = $property.Value.path
        if (!$path) {
          continue
        }

        $normalizedPath = [System.IO.Path]::GetFullPath([string]$path).TrimEnd('\')
        if ($normalizedPath -eq $normalizedRoot) {
          return $property.Name
        }
      }
    } catch {
      continue
    }
  }

  return $null
}

if (!$ExtensionId) {
  $ExtensionId = Get-ExistingExtensionId
}

if (!$ExtensionId) {
  $ExtensionId = Find-ExtensionIdInChromeProfiles
}

if (!$ExtensionId) {
  throw @"
Extension ID was not detected automatically.
Open chrome://extensions, copy this extension's ID, then run:
  .\install-native-host.ps1 -ExtensionId "YOUR_EXTENSION_ID"
"@
}

New-Item -ItemType Directory -Path $publishDir -Force | Out-Null

$exePath = Join-Path $publishDir "B24SlicerLauncher.exe"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (!(Test-Path -LiteralPath $csc)) {
  $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (!(Test-Path -LiteralPath $csc)) {
  throw "C# compiler was not found. Expected csc.exe in Microsoft.NET Framework v4.0.30319."
}

& $csc /nologo /target:exe /out:$exePath $source

if (!(Test-Path -LiteralPath $exePath)) {
  throw "Native host executable was not created: $exePath"
}

$hostManifest = [ordered]@{
  name = $hostName
  description = "Launches local slicers for Bitrix task model files"
  path = $exePath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$hostManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $hostManifestPath -Encoding UTF8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name "(default)" -Value $hostManifestPath

Write-Host "Installed native host '$hostName' for chrome-extension://$ExtensionId/"
Write-Host "Manifest: $hostManifestPath"
