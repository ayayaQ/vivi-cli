# SPDX-License-Identifier: Apache-2.0
# Harmless native argv fixture. Encoding is fixed so Unicode output is observable.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$manifest = [IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Import-Module -Name $manifest -ErrorAction Stop
[Console]::Out.WriteLine((Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @($args) -Compress))
