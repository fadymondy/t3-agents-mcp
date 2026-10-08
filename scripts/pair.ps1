$ErrorActionPreference = 'Stop'
$credentialDir = Join-Path $env:USERPROFILE '.t3-code-agent-mcp'
if ($env:T3_MCP_CREDENTIALS) { throw 'Custom credential path: secure its ACL and use pair --stdin directly.' }
New-Item -ItemType Directory -Force -Path $credentialDir | Out-Null
$acl = Get-Acl -LiteralPath $credentialDir
$acl.SetAccessRuleProtection($true, $false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $credentialDir -AclObject $acl
$secret = Read-Host 'Paste your LOCAL or explicitly trusted T3 pairing link (hidden)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $plain | node (Join-Path $PSScriptRoot '../dist/cli.js') pair --stdin
    if ($LASTEXITCODE -ne 0) { throw 'Pairing failed.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $plain = $null
    $secret.Dispose()
}
