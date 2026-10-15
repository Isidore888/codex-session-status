$ErrorActionPreference='Stop'
function Assert($Condition,$Message){if(-not $Condition){throw $Message}}
$file=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\manage.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$null,[ref]$null)
$switch=$ast.Find({param($node) $node -is [Management.Automation.Language.SwitchStatementAst]},$false)
Assert ($null -ne $switch) 'management-switch-missing'
# Run the actual action bodies with every external effect replaced.
$fixture=[scriptblock]::Create('[CmdletBinding(SupportsShouldProcess)] param([string]$Action)' + "`n" + $switch.Extent.Text)
function Get-OwnedStatusTask { [pscustomobject]@{State='Running'} }
function Get-WatchHealth { @{ok=$true} }
function Ensure-StatusEnvironment { throw 'environment-before-confirmation' }
function Remove-LegacyDesktopShortcut { throw 'shortcut-before-confirmation' }
function Stop-StatusWatch { throw 'stop-before-confirmation' }
function Build-StatusLauncher { throw 'build-before-confirmation' }
function Register-ScheduledTask { throw 'registration-before-confirmation' }
function Unregister-ScheduledTask { throw 'unregister-before-confirmation' }
$WatchTaskName='isolated-fixture-task'
foreach($action in @('Setup','Install','Uninstall')){ & $fixture -Action $action -WhatIf }
Write-Output 'PASS: Setup/Install/Uninstall cancellation has no environment, shortcut, stop, build or task effects'
