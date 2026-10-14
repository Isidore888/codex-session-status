. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\windows.ps1')
$fixtureRoot = Join-Path $RuntimeRoot ('unit\windows-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$listeners = [Collections.Generic.List[Net.Sockets.TcpListener]]::new()
try {
    $first = Join-Path $fixtureRoot 'OpenAI.Codex_1.0_x64__testpublisher'
    $second = Join-Path $fixtureRoot 'OpenAI.Codex_2.0_x64__testpublisher'
    foreach ($entry in @(@($first,'1.0.0.0'),@($second,'2.0.0.0'))) {
        New-Item -ItemType Directory -Path (Join-Path $entry[0] 'app') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $entry[0] 'app\ChatGPT.exe') -Value '' -Encoding utf8
        $manifest = '<Package><Identity Name="OpenAI.Codex" Version="' + $entry[1] +
            '"/><Applications><Application Id="App" Executable="app\ChatGPT.exe"/></Applications></Package>'
        Set-Content -LiteralPath (Join-Path $entry[0] 'AppxManifest.xml') -Value $manifest -Encoding utf8
    }
    $script:mockRoot = $first
    function Get-AppxPackage { param($Name,$ErrorAction)
        [pscustomobject]@{ InstallLocation=$script:mockRoot; Version=[version]'2.0';
            PackageFamilyName='OpenAI.Codex_testpublisher' }
    }
    if ((Resolve-Codex).Root -ne $first) { throw 'Initial discovery failed' }
    $script:mockRoot = $second
    if ((Resolve-Codex).Root -ne $second) { throw 'Updated location discovery failed' }
    if ((Resolve-Codex).AppId -ne 'OpenAI.Codex_testpublisher!App') { throw 'Activation ID failed' }
    # Occupied ports are left untouched. Bind only currently free candidates and release our own listeners.
    for ($port=9345; $port -le 9376; $port++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start(); $listeners.Add($listener) }
        catch { $listener.Stop() }
        if ($port -eq 9345) {
            $chosen = Find-FreePort
            if ($chosen -eq 9345) { throw 'Occupied port was reused' }
        }
    }
    $rejected = $false
    try { Find-FreePort | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Exhausted ports must fail safely' }
    Write-Output 'PASS: Windows discovery, updated installation path, occupied/exhausted ports'
} finally {
    foreach ($listener in $listeners) { $listener.Stop() }
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $allowed = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'unit')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path rejected' }
    # Delete only exact files created above; directory removal then requires emptiness.
    foreach ($entry in @($first,$second)) {
        foreach ($file in @((Join-Path $entry 'app\ChatGPT.exe'),(Join-Path $entry 'AppxManifest.xml'))) {
            if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
        }
        if(Test-Path -LiteralPath (Join-Path $entry 'app')){Remove-Item -LiteralPath (Join-Path $entry 'app')}
        if(Test-Path -LiteralPath $entry){Remove-Item -LiteralPath $entry}
    }
    Remove-Item -LiteralPath $resolved
    if (Test-Path -LiteralPath $resolved) { throw 'Fixture cleanup failed' }
}
