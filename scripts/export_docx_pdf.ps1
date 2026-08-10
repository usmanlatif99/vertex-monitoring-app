param(
  [string]$InputDocx = (Join-Path $PSScriptRoot '..\docs\VE-WorkLog-WebAuthn-Attendance-Development-Handoff.docx'),
  [string]$OutputPdf = (Join-Path $PSScriptRoot '..\docs\qa-webauthn\VE-WorkLog-WebAuthn-Attendance-Development-Handoff.pdf')
)
$ErrorActionPreference = 'Stop'
$docx = [System.IO.Path]::GetFullPath($InputDocx)
$pdf = [System.IO.Path]::GetFullPath($OutputPdf)
New-Item -ItemType Directory -Force -Path (Split-Path $pdf) | Out-Null
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($docx, $false, $true)
  $doc.ExportAsFixedFormat($pdf, 17)
  $doc.Close($false)
} finally {
  $word.Quit()
}
Write-Output $pdf
