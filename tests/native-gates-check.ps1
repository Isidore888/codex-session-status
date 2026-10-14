$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-common.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\source-gates.ps1')
$originalRuntime=$RuntimeRoot
$fixture=Join-Path $RuntimeRoot ('unit\gates-'+[Guid]::NewGuid().ToString('N'))
$RuntimeRoot=$fixture
$verification=Join-Path $fixture 'verification'
$file=Join-Path $verification 'native-acceptance.json'
[IO.Directory]::CreateDirectory($verification) | Out-Null
function Reject([string]$Code) {
    try { Assert-StatusNativeAcceptance ([pscustomobject]@{Version='fixture-version'}) }
    catch { if($_.Exception.Message -eq $Code){return};throw }
    throw ('gate-accepted-'+$Code)
}
try {
    Reject 'native-acceptance-required'
    $report=@{clientVersion='fixture-version';launchMethod='installed-exe';sourceHashes=(Get-StatusSourceHashes)}
    $fields=@('normalExitPassed','cdpPassed','originalEntryPassed','directExePassed','fiveFieldsPassed','sixFieldsPassed','taskDurationPassed','sessionSwitchPassed','codexWorkPassed','geometryPassed')
    foreach($field in $fields){$report[$field]=$true}
    function Save-Report { $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding UTF8 }
    foreach($field in $fields){$report[$field]=$false;Save-Report;Reject 'native-acceptance-required';$report[$field]=$true}
    $report.Remove('cdpPassed');$report.storeCdpPassed=$true;Save-Report;Reject 'native-acceptance-required'
    $report.cdpPassed=$true;$report.launchMethod='store';Save-Report;Reject 'native-acceptance-stale'
    $report.launchMethod='installed-exe';$report.clientVersion='old';Save-Report;Reject 'native-acceptance-stale'
    $report.clientVersion='fixture-version';$report.sourceHashes['src/cdp.mjs']='old';Save-Report;Reject 'native-acceptance-stale'
    $report.sourceHashes=Get-StatusSourceHashes;Save-Report
    Assert-StatusNativeAcceptance ([pscustomobject]@{Version='fixture-version'})
    Write-Output 'PASS: isolated native gates reject each missing result, Store-only evidence, wrong launcher/version/source'
} finally {
    $allowed=[IO.Path]::GetFullPath((Join-Path $originalRuntime 'unit'))+[IO.Path]::DirectorySeparatorChar
    if(-not [IO.Path]::GetFullPath($fixture).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'cleanup-path-rejected'}
    if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
    Remove-Item -LiteralPath $verification
    Remove-Item -LiteralPath $fixture
    if(Test-Path -LiteralPath $fixture){throw 'fixture-remained'}
    $RuntimeRoot=$originalRuntime
}
