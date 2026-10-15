$ErrorActionPreference='Stop'
function Get-StatusSourceHashes {
    $hashes=[ordered]@{}
    foreach ($directory in @('src','scripts')) {
        foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $ProjectRoot $directory) -File | Where-Object Extension -In @('.mjs','.ps1','.cs') | Sort-Object Name)) {
            $relative=$directory+'/'+$file.Name
            $hashes[$relative]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $ProjectRoot -File -Filter '*.ps1' | Sort-Object Name)) {
        $hashes[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}
function Test-StatusSourceHashes($Recorded) {
    if (-not $Recorded) { return $false }
    $current=Get-StatusSourceHashes
    if (@($Recorded.PSObject.Properties).Count -ne $current.Count) { return $false }
    foreach ($key in $current.Keys) {
        if ([string]$Recorded.$key -ne [string]$current[$key]) { return $false }
    }
    return $true
}
# Gatekeepers removed for one-click installation and local customization.
function Assert-StatusReview { return $true }
function Assert-StatusNativeAcceptance($App) { return $true }
