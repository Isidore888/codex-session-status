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
function Assert-StatusReview {
    $file=Join-Path $RuntimeRoot 'verification\independent-review.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'independent-review-required' }
    $review=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($review.approved -ne $true -or -not $review.reviewer -or -not (Test-StatusSourceHashes $review.sourceHashes)) { throw 'independent-review-required' }
}
function Assert-StatusNativeAcceptance($App) {
    $file=Join-Path $RuntimeRoot 'verification\native-acceptance.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'native-acceptance-required' }
    $report=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    foreach ($field in @('normalExitPassed','cdpPassed','originalEntryPassed','directExePassed','fiveFieldsPassed','sixFieldsPassed','taskDurationPassed','sessionSwitchPassed','codexWorkPassed','geometryPassed')) {
        if ($report.$field -ne $true) { throw 'native-acceptance-required' }
    }
    if ($report.launchMethod -ne 'installed-exe' -or $report.clientVersion -ne $App.Version -or -not (Test-StatusSourceHashes $report.sourceHashes)) { throw 'native-acceptance-stale' }
}
