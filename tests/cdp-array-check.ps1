$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\windows.ps1')
# Match Invoke-RestMethod's single JSON-array pipeline object, not an enumerating mock.
function Invoke-RestMethod {
    param($Uri,$TimeoutSec,$MaximumRedirection)
    if ($Uri -ne 'http://127.0.0.1:9345/json/list' -or $MaximumRedirection -ne 0) { throw 'unexpected-endpoint' }
    $items=@(
        [pscustomobject]@{type='page';url='app://-/index.html';webSocketDebuggerUrl='ws://127.0.0.1:9345/devtools/page/fixture'},
        [pscustomobject]@{type='page';url='app://-/index.html?initialRoute=avatar';webSocketDebuggerUrl='ws://127.0.0.1:9345/devtools/page/avatar'},
        [pscustomobject]@{type='page';url='https://example.test/';webSocketDebuggerUrl='ws://127.0.0.1:9345/devtools/page/external'},
        [pscustomobject]@{type='worker';url='';webSocketDebuggerUrl='ws://127.0.0.1:9345/devtools/page/worker'},
        [pscustomobject]@{type='page';url='app://-/index.html';webSocketDebuggerUrl='ws://127.0.0.1:9346/devtools/page/wrong-port'}
    )
    Write-Output -NoEnumerate $items
}
$pages=@(Get-CdpTargets 9345)
if ($pages.Count -ne 1 -or $pages[0].url -ne 'app://-/index.html') { throw 'JSON-array-page-enumeration-failed' }
Write-Output 'PASS: non-enumerated JSON-array CDP response and strict target filtering (isolated)'
