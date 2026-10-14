$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\watch-common.ps1')
$file=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\manage.ps1'
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'manage-syntax'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-OwnedStatusTask'},$false)
# Extract only this trusted project function; never invoke manager actions in fixture tests.
Invoke-Expression $function.Extent.Text
$shell='fixture-shell';$taskArguments='fixture-arguments';$description='fixture-description';$userSid='S-1-5-21-1'
$guiLauncher='fixture-gui-launcher'
$script:fixtureTask=[pscustomobject]@{
    Description=$description;Actions=@([pscustomobject]@{Execute=$shell;Arguments=$taskArguments;WorkingDirectory=$ProjectRoot});
    Principal=[pscustomobject]@{UserId=$userSid;RunLevel='Limited';LogonType='Interactive'};
    Settings=[pscustomobject]@{MultipleInstances='IgnoreNew'};Triggers=$null
}
function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) $script:fixtureTask }
function Reject($Message) {
    try { Get-OwnedStatusTask | Out-Null } catch { if($_.Exception.Message -eq 'task-ownership-unverified'){return};throw }
    throw $Message
}
if(-not (Get-OwnedStatusTask)){throw 'null-trigger-rejected'}
$script:fixtureTask.Triggers=@()
if(-not (Get-OwnedStatusTask)){throw 'empty-triggers-rejected'}
$script:fixtureTask.Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskLogonTrigger'};UserId=$userSid})
if(-not (Get-OwnedStatusTask)){throw 'own-logon-trigger-rejected'}
$script:fixtureTask.Triggers[0].UserId='S-1-5-18';Reject 'foreign-trigger-accepted'
$savedSid=$userSid
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$userSid=$identity.User.Value
$script:fixtureTask.Principal.UserId=$userSid
$script:fixtureTask.Triggers[0].UserId=$identity.Name
if(-not (Get-OwnedStatusTask)){throw 'normalized-own-account-trigger-rejected'}
$script:fixtureTask.Triggers[0].UserId='NT AUTHORITY\SYSTEM';Reject 'foreign-account-trigger-accepted'
$script:fixtureTask.Triggers[0].UserId='codex-status-nonexistent-'+[Guid]::NewGuid().ToString('N');Reject 'unresolvable-account-trigger-accepted'
$userSid=$savedSid
$script:fixtureTask.Principal.UserId=$userSid
$script:fixtureTask.Triggers=$null
$script:fixtureTask.Actions[0].WorkingDirectory='foreign';Reject 'foreign-working-directory-accepted'
$script:fixtureTask.Actions[0].WorkingDirectory=$ProjectRoot
$script:fixtureTask.Principal.UserId='S-1-5-18';Reject 'foreign-user-accepted'
$script:fixtureTask.Principal.UserId=$userSid
$script:fixtureTask.Description='foreign';Reject 'foreign-description-accepted'
$script:fixtureTask.Description=$description
$script:fixtureTask.Actions[0].Execute=$guiLauncher;$script:fixtureTask.Actions[0].Arguments=''
if(-not (Get-OwnedStatusTask)){throw 'own-gui-action-rejected'}
$script:fixtureTask.Actions[0].Arguments='foreign';Reject 'gui-arguments-accepted'
$script:fixtureTask.Actions[0].Arguments='';$script:fixtureTask.Actions[0].Execute='foreign';Reject 'foreign-launcher-accepted'
Write-Output 'PASS: demand-null/empty, own SID/account-name logon tasks; foreign/unresolvable trigger, user, directory and description rejected'
