$ErrorActionPreference='Stop'
function Get-StatusLauncherPath { Join-Path $RuntimeRoot 'launcher\StatusWatcher.exe' }
function Test-StatusLauncher {
    $exe=Get-StatusLauncherPath
    $manifest=Join-Path $RuntimeRoot 'launcher\build.json'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or -not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
    try {
        $record=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        foreach($name in @('watch-launcher.cs','watch-console.cs')) {
            if ($record.sources.$name -ne (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash) { return $false }
        }
        return $record.binary -eq (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
    } catch { return $false }
}
function Build-StatusLauncher {
    Assert-StatusReview
    if (Test-StatusLauncher) { return }
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'windows-compiler-unavailable' }
    $exe=Get-StatusLauncherPath
    [IO.Directory]::CreateDirectory((Split-Path -Parent $exe)) | Out-Null
    $sources=[ordered]@{}
    foreach($name in @('watch-launcher.cs','watch-console.cs')) { $sources[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash }
    $result=[SessionStatusConsole]::RunHidden($compiler,@('/nologo','/target:winexe','/r:System.Runtime.Serialization.dll',('/out:'+$exe),(Join-Path $PSScriptRoot 'watch-console.cs'),(Join-Path $PSScriptRoot 'watch-launcher.cs')),$ProjectRoot)
    if ($result.ExitCode -ne 0) { throw 'launcher-build-failed' }
    @{sources=$sources;binary=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'launcher\build.json') -Encoding utf8
    if (-not (Test-StatusLauncher)) { throw 'launcher-build-unverified' }
}
