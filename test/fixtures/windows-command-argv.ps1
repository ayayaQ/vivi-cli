# SPDX-License-Identifier: Apache-2.0
# Harmless native argv fixture. Encoding is fixed so Unicode output is observable.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($args) -Compress))
