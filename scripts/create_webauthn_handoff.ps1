$ErrorActionPreference = 'Stop'

$outputDir = Join-Path $PSScriptRoot '..\docs'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $outputDir 'VE-WorkLog-WebAuthn-Attendance-Development-Handoff.docx'))
$pdfPath = [System.IO.Path]::ChangeExtension($outputPath, '.pdf')

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Add()

function Convert-HexToWordColor([string]$hex) {
  $hex = $hex.TrimStart('#')
  $r = [Convert]::ToInt32($hex.Substring(0,2),16)
  $g = [Convert]::ToInt32($hex.Substring(2,2),16)
  $b = [Convert]::ToInt32($hex.Substring(4,2),16)
  return $r + (256 * $g) + (65536 * $b)
}

function Set-ParagraphFormat($p, [double]$before=0, [double]$after=6, [double]$line=15, [int]$keep=0) {
  $p.Format.SpaceBefore = $before
  $p.Format.SpaceAfter = $after
  $p.Format.LineSpacingRule = 5
  $p.Format.LineSpacing = $line
  $p.Format.KeepWithNext = $(if ($keep) { -1 } else { 0 })
}

function Set-Run($range, [string]$font='Calibri', [double]$size=11, [int]$bold=0, [string]$color='1A2332') {
  $range.Font.Name = $font
  $range.Font.Size = $size
  $range.Font.Bold = $bold
  $range.Font.Color = Convert-HexToWordColor $color
}

function Add-Para([string]$text, [double]$after=6, [int]$bold=0, [double]$size=11, [string]$color='1A2332') {
  $p = $doc.Paragraphs.Add()
  $p.Range.Text = $text
  Set-Run $p.Range 'Calibri' $size $bold $color
  Set-ParagraphFormat $p 0 $after 15 0
  return $p
}

function Add-Heading([string]$text, [int]$level=1) {
  $p = $doc.Paragraphs.Add()
  $p.Range.Text = $text
  if ($level -eq 1) { Set-Run $p.Range 'Calibri' 16 1 '2E74B5'; Set-ParagraphFormat $p 18 10 16 1 }
  elseif ($level -eq 2) { Set-Run $p.Range 'Calibri' 13 1 '2E74B5'; Set-ParagraphFormat $p 14 7 15 1 }
  else { Set-Run $p.Range 'Calibri' 12 1 '1F4D78'; Set-ParagraphFormat $p 10 5 15 1 }
  $p.OutlineLevel = $level
  return $p
}

function Add-Bullet([string]$text, [int]$level=0) {
  $p = $doc.Paragraphs.Add()
  $p.Range.Text = $text
  Set-Run $p.Range
  $p.Range.ListFormat.ApplyBulletDefault()
  $p.Format.LeftIndent = 27 + (18 * $level)
  $p.Format.FirstLineIndent = -13.5
  Set-ParagraphFormat $p 0 4 15 0
  return $p
}

function Add-Number([string]$text) {
  $p = $doc.Paragraphs.Add()
  $p.Range.Text = $text
  Set-Run $p.Range
  $p.Range.ListFormat.ApplyNumberDefault()
  $p.Format.LeftIndent = 27
  $p.Format.FirstLineIndent = -13.5
  Set-ParagraphFormat $p 0 4 15 0
  return $p
}

function Shade-Cell($cell, [string]$hex) {
  $cell.Shading.BackgroundPatternColor = Convert-HexToWordColor $hex
}

function Add-Table($headers, $rows, $widths) {
  $range = $doc.Content
  $range.Collapse(0)
  $table = $doc.Tables.Add($range, $rows.Count + 1, $headers.Count)
  $table.AllowAutoFit = $false
  $table.Borders.Enable = 1
  $table.Rows.AllowBreakAcrossPages = $true
  $table.Rows.Item(1).HeadingFormat = $true
  for ($c=1; $c -le $headers.Count; $c++) {
    $cell = $table.Cell(1,$c)
    $cell.Range.Text = [string]$headers[$c-1]
    Set-Run $cell.Range 'Calibri' 10.5 1 '0B2545'
    Shade-Cell $cell 'E8EEF5'
    $cell.Width = $widths[$c-1] * 72
    $cell.VerticalAlignment = 1
  }
  for ($r=0; $r -lt $rows.Count; $r++) {
    for ($c=0; $c -lt $headers.Count; $c++) {
      $cell = $table.Cell($r+2,$c+1)
      $cell.Range.Text = [string]$rows[$r][$c]
      Set-Run $cell.Range 'Calibri' 10 0 '1A2332'
      $cell.Width = $widths[$c] * 72
      $cell.VerticalAlignment = 1
    }
  }
  foreach ($cell in $table.Range.Cells) {
    $cell.TopPadding = 4; $cell.BottomPadding = 4; $cell.LeftPadding = 6; $cell.RightPadding = 6
  }
  $table.Range.ParagraphFormat.SpaceAfter = 0
  $after = $doc.Paragraphs.Add()
  Set-ParagraphFormat $after 0 6 15 0
  return $table
}

function Add-Callout([string]$label, [string]$text, [string]$fill='F4F6F9') {
  $range = $doc.Content; $range.Collapse(0)
  $t = $doc.Tables.Add($range,1,1); $t.AllowAutoFit=$false; $t.Columns.Item(1).Width=6.5*72
  $cell=$t.Cell(1,1); Shade-Cell $cell $fill; $cell.TopPadding=8; $cell.BottomPadding=8; $cell.LeftPadding=10; $cell.RightPadding=10
  $cell.Range.Text = "$label`r$text"
  Set-Run $cell.Range 'Calibri' 10.5 0 '1A2332'
  $first = $cell.Range.Paragraphs.Item(1).Range; Set-Run $first 'Calibri' 10.5 1 '1F4D78'
  $after=$doc.Paragraphs.Add(); Set-ParagraphFormat $after 0 6 15 0
}

# Page geometry and document defaults
$section = $doc.Sections.Item(1)
$section.PageSetup.PageWidth = 8.5*72; $section.PageSetup.PageHeight = 11*72
$section.PageSetup.TopMargin = 72; $section.PageSetup.BottomMargin = 72
$section.PageSetup.LeftMargin = 72; $section.PageSetup.RightMargin = 72
$section.PageSetup.HeaderDistance = 35.4; $section.PageSetup.FooterDistance = 35.4

$normal = $doc.Styles.Item('Normal')
$normal.Font.Name='Calibri'; $normal.Font.Size=11
$normal.ParagraphFormat.SpaceAfter=6; $normal.ParagraphFormat.LineSpacingRule=5; $normal.ParagraphFormat.LineSpacing=15

# Running header/footer
$header=$section.Headers.Item(1).Range
$header.Text='VE WorkLog | WebAuthn Attendance Development Handoff'
Set-Run $header 'Calibri' 9 0 '6B7A90'
$footer=$section.Footers.Item(1).Range
$footer.ParagraphFormat.Alignment=2
$footer.Text='Internal technical reference  |  Page '
Set-Run $footer 'Calibri' 9 0 '6B7A90'
$footer.Collapse(0); $null=$footer.Fields.Add($footer,-1,'PAGE',$true)

# Title block
$p=$doc.Paragraphs.Add(); $p.Range.Text='TECHNICAL DEVELOPMENT HANDOFF'; Set-Run $p.Range 'Calibri' 10 1 '1089CC'; Set-ParagraphFormat $p 0 4 12 1
$p=$doc.Paragraphs.Add(); $p.Range.Text='WebAuthn-Secured Attendance for VE WorkLog'; Set-Run $p.Range 'Calibri' 24 1 '0B2545'; Set-ParagraphFormat $p 0 6 27 1
$p=$doc.Paragraphs.Add(); $p.Range.Text='Device registration, passkey verification, anti-buddy-punching controls, limitations, and implementation specification'; Set-Run $p.Range 'Calibri' 12 0 '5A6A82'; Set-ParagraphFormat $p 0 14 16 1
Add-Table @('Document field','Value') @(
  @('Application','VE WorkLog - Vertex Electronics and Vision Engineering'),
  @('Production domain','https://tasks.vertex.pk'),
  @('Prepared for','AI/developer implementation handoff'),
  @('Prepared date','10 August 2026'),
  @('Status','Proposed WebAuthn enhancement; employee Attendance navigation currently paused')
) @(1.55,4.95) | Out-Null

Add-Callout 'Executive decision' 'Add WebAuthn user verification and an admin-approved attendance credential to the existing GPS attendance flow. This materially reduces password-only buddy punching, but it cannot guarantee that fingerprint or Face ID - rather than device PIN - was used. For deliberate collusion involving the approved phone and its PIN, add live selfie/liveness or dedicated biometric hardware.' 'EAF3F8'

Add-Heading '1. Purpose and scope' 1
Add-Para 'This document consolidates the complete discussion about adding WebAuthn/passkey-based identity verification to the existing VE WorkLog attendance module. It is written so another AI or developer can continue implementation without the original conversation.'
Add-Bullet 'Preserve the existing username/password login and JWT session model.'
Add-Bullet 'Add a second, attendance-specific authorization step using an approved WebAuthn credential.'
Add-Bullet 'Require the approved credential for both normal check-in and normal checkout.'
Add-Bullet 'Retain GPS validation and existing manual/admin approval fallbacks.'
Add-Bullet 'Allow one active approved attendance credential per employee by policy.'
Add-Bullet 'Do not store fingerprints, facial templates, device PINs, or other biometric data.'

Add-Heading '2. Existing VE WorkLog attendance context' 1
Add-Para 'The WebAuthn feature extends an already implemented browser-based attendance module. The current attendance rules and workflows must remain operational unless explicitly changed during development.'
Add-Table @('Current control','Existing behavior') @(
  @('Office location','31.441300523433583, 74.32441912480384; shared VE/VSN office'),
  @('Office radius','Approximately 100 metres, verified server-side with browser GPS coordinates'),
  @('Check-in window','Before 7:00 AM PKT is blocked'),
  @('Present','Check-in from 7:00 AM through 9:35 AM PKT'),
  @('Late','Check-in after 9:35 AM and before 11:00 AM PKT'),
  @('Half Day','Check-in at or after 11:00 AM PKT'),
  @('Monthly deductions','3 lates = 1 absence; 2 half-days = 1 absence'),
  @('Normal checkout','Employee must normally be at the office location'),
  @('Early Leave / Remote','Checkout outside the office requires mandatory remarks and admin approval'),
  @('Manual check-in','Used when location is denied/unavailable; mandatory reason and admin approval'),
  @('Pending check-in','Employee may still submit checkout while check-in approval is pending'),
  @('Administration','Daily/monthly reporting, approvals, manual correction, PDF export, user attendance toggle')
) @(1.65,4.85) | Out-Null
Add-Callout 'Current testing state' 'The Attendance item is intentionally hidden from employee navigation while testing is paused. Admin Attendance screens remain available. When WebAuthn testing resumes, restore attendance in both employee navigation definitions: the route allow-list (empViews) and the visible sidebar list (empItems) in public/app.js.' 'FFF4D6'

Add-Heading '3. Threat model: buddy punching' 1
Add-Para 'GPS validates where a device is located; it does not prove who is operating the device. Under the current system, a colleague at the office can mark attendance for an absent employee if that colleague has the employee account credentials.'
Add-Heading '3.1 What WebAuthn prevents' 2
Add-Bullet 'A colleague who knows the employee portal password but uses an unregistered phone cannot complete attendance because the approved private credential is missing.'
Add-Bullet 'A copied password is insufficient because every attendance action requires a fresh server challenge signed by the approved WebAuthn credential.'
Add-Bullet 'A credential registered for another website cannot be replayed against tasks.vertex.pk because the signature is bound to the relying-party domain and expected origin.'
Add-Heading '3.2 What WebAuthn does not fully prevent' 2
Add-Bullet 'If the employee hands over the approved phone and also shares the device PIN, the colleague may satisfy user verification.'
Add-Bullet 'The website cannot reliably force fingerprint-only or Face-ID-only verification. It asks for user verification; the device chooses fingerprint, face, PIN, pattern, computer password, or security-key PIN.'
Add-Bullet 'The server receives a verified/not-verified result, not the biometric modality.'
Add-Bullet 'Some passkeys can synchronize through Apple iCloud Keychain, Google Password Manager, or another credential provider; one WebAuthn credential is not always equivalent to one physical device.'
Add-Bullet 'An unlocked or deliberately shared device and deliberate cooperation remain risks in any browser-only design.'

Add-Heading '4. Recommended layered security model' 1
Add-Table @('Layer','Purpose','Decision') @(
  @('JWT login','Identifies the portal account','Keep existing login'),
  @('Approved WebAuthn credential','Proves control of the registered attendance credential','Required for normal check-in/out'),
  @('User verification','Requires device-level fingerprint/face/PIN/password','Set userVerification to required'),
  @('Office GPS','Confirms physical proximity to office','Keep existing server-side radius check'),
  @('GPS accuracy','Rejects unusably imprecise locations','Add an explicit maximum accuracy threshold'),
  @('Admin approval','Prevents employees from silently registering replacement credentials','Required for registration/replacement'),
  @('Audit metadata','Supports investigation','Record credential, time, coordinates, accuracy, IP, user agent'),
  @('Optional live selfie/liveness','Deters collusion with approved phone/PIN','Phase 2 or risk-triggered'),
  @('Dedicated biometric terminal','Strongest fingerprint/face enforcement','Future option if strict identity proof is required')
) @(1.25,2.55,2.70) | Out-Null

Add-Heading '5. User experience and application states' 1
Add-Heading '5.1 Employee device states' 2
Add-Table @('State','Employee interface','Attendance behavior') @(
  @('No device','Register this device','Normal attendance blocked until approved'),
  @('Pending','Device details and Awaiting admin approval','Normal attendance blocked; manual request available'),
  @('Approved','Approved status and attendance controls','WebAuthn + GPS required'),
  @('Rejected','Rejection status and new request action','Normal attendance blocked'),
  @('Revoked','Register replacement device','Old credential cannot be used'),
  @('Replacement pending','Old/new status and request reason','Apply management policy on whether old device remains active')
) @(1.25,2.55,2.70) | Out-Null
Add-Heading '5.2 Registration flow' 2
Add-Number 'Employee signs in on the intended attendance phone and opens Attendance.'
Add-Number 'Employee selects Register this device.'
Add-Number 'Server creates a short-lived, single-use WebAuthn registration challenge.'
Add-Number 'Browser invokes the platform authenticator; the phone requests fingerprint, Face ID, screen-lock PIN, or another supported verification method.'
Add-Number 'The private key remains in the authenticator; the application receives a public credential response.'
Add-Number 'Server verifies the challenge, expected origin, relying-party ID, and user verification result.'
Add-Number 'Credential is stored with status Pending and appears in Admin Device Approvals.'
Add-Number 'Admin verifies the employee and approves or rejects the credential.'

Add-Heading '5.3 Normal check-in/check-out flow' 2
Add-Number 'Employee selects Check In or Check Out.'
Add-Number 'Frontend requests authentication options from the server.'
Add-Number 'Server issues a new short-lived, single-use challenge restricted to the employee approved credential.'
Add-Number 'Browser requests device verification and returns a signed assertion.'
Add-Number 'Frontend obtains current GPS latitude, longitude, and accuracy.'
Add-Number 'Frontend submits the signed WebAuthn assertion and GPS payload together.'
Add-Number 'Server verifies WebAuthn first, then GPS/radius/accuracy, then applies attendance time rules.'
Add-Number 'Server updates the credential signature counter and records the attendance event and audit data.'

Add-Heading '5.4 Buddy-punching outcome' 2
Add-Callout 'Expected outcome' 'A colleague can log into the absent employee account and may be physically inside the office radius, but attendance is blocked because the approved private credential is unavailable. The employee must use the approved device or submit a manual request for admin review.' 'FCE8E8'

Add-Heading '6. WebAuthn technical configuration' 1
Add-Table @('Setting','Production value / recommendation') @(
  @('Relying-party name','VE WorkLog'),
  @('Relying-party ID','tasks.vertex.pk'),
  @('Expected origin','https://tasks.vertex.pk'),
  @('Registration attestation','none initially; avoids unnecessary device-identification complexity'),
  @('Authenticator attachment','platform preferred'),
  @('Resident key','preferred'),
  @('User verification','required for registration and authentication'),
  @('Challenge lifetime','Recommended 3-5 minutes; one-time use'),
  @('Credential policy','One active approved credential per employee'),
  @('Transport storage','Store authenticator transports when provided'),
  @('Recommended Node package','@simplewebauthn/server; browser helper optional'),
  @('HTTPS','Mandatory; already available at tasks.vertex.pk')
) @(2.05,4.45) | Out-Null

Add-Heading '7. Proposed database design' 1
Add-Heading '7.1 attendance_credentials' 2
Add-Table @('Column','Purpose') @(
  @('id','Primary key'),
  @('user_id','Employee owner; foreign key to users'),
  @('credential_id','Unique WebAuthn credential identifier'),
  @('public_key','Credential public key in binary form'),
  @('counter','Signature counter used during authentication verification'),
  @('transports','Optional browser-reported authenticator transports'),
  @('device_name','Admin/employee-friendly label, not a security assertion'),
  @('browser_info','User-agent/device description for audit only'),
  @('status','pending, approved, rejected, revoked'),
  @('registered_at','Registration timestamp'),
  @('approved_by / approved_at','Admin approval audit'),
  @('revoked_at / revocation_reason','Revocation audit')
) @(2.25,4.25) | Out-Null
Add-Heading '7.2 webauthn_challenges' 2
Add-Para 'Store registration and authentication challenges server-side. Each record should contain user_id, challenge, purpose, expiry, and optionally the attendance action being authorized. Challenges must expire quickly and be deleted or marked consumed after one successful use.'
Add-Heading '7.3 Attendance audit additions' 2
Add-Bullet 'Credential ID or credential record ID used for the event.'
Add-Bullet 'Boolean/user-verification result and verification timestamp.'
Add-Bullet 'GPS accuracy supplied by the browser and distance calculated server-side.'
Add-Bullet 'Request IP address and user agent for anomaly review, with an appropriate retention policy.'
Add-Bullet 'Verification mode: webauthn, manual, or admin override.'

Add-Heading '8. Proposed API surface' 1
Add-Table @('Endpoint','Purpose','Access') @(
  @('POST /api/webauthn/register/options','Generate registration challenge/options','Logged-in employee'),
  @('POST /api/webauthn/register/verify','Verify response and save pending credential','Logged-in employee'),
  @('POST /api/webauthn/auth/options','Generate check-in/out authentication challenge','Logged-in employee'),
  @('POST /api/webauthn/auth/verify','Optional separate assertion verification endpoint','Logged-in employee'),
  @('GET /api/webauthn/device','Return employee credential/approval status','Logged-in employee'),
  @('POST /api/webauthn/device/replace','Request replacement with mandatory reason','Logged-in employee'),
  @('GET /api/webauthn/admin/devices','List pending/approved/revoked credentials','Admin'),
  @('PUT /api/webauthn/admin/devices/:id/approve','Approve credential; enforce one-active policy','Admin'),
  @('PUT /api/webauthn/admin/devices/:id/reject','Reject pending credential','Admin'),
  @('PUT /api/webauthn/admin/devices/:id/revoke','Revoke approved credential','Admin'),
  @('POST /api/attendance/checkin','Verify assertion + GPS and record check-in','Employee'),
  @('POST /api/attendance/checkout','Verify assertion + GPS and record checkout','Employee')
) @(2.55,2.85,1.10) | Out-Null
Add-Callout 'Security requirement' 'The server must generate and verify every WebAuthn challenge. A frontend-only biometric success message is not secure and must never be accepted as proof.' 'FFF4D6'

Add-Heading '9. Server-side validation sequence' 1
Add-Number 'Authenticate the JWT and load the active employee.'
Add-Number 'Confirm attendance is enabled for the employee and an approved credential exists.'
Add-Number 'Load a matching, unexpired, unused challenge with the correct purpose/action.'
Add-Number 'Verify credential ID, signed challenge, expected origin, RP ID, and user verification.'
Add-Number 'Check the credential is still approved and not revoked.'
Add-Number 'Validate and update the signature counter using the WebAuthn library result.'
Add-Number 'Validate numeric latitude, longitude, accuracy, and office distance server-side.'
Add-Number 'Apply check-in window, late, half-day, manual, and checkout rules.'
Add-Number 'Record attendance and immutable audit metadata in one database transaction where practical.'
Add-Number 'Consume the challenge so it cannot be replayed.'

Add-Heading '10. Device replacement and recovery' 1
Add-Bullet 'Employee submits Replace Device with a mandatory reason.'
Add-Bullet 'Admin reviews the request and revokes the old credential before or during approval of the replacement.'
Add-Bullet 'A lost-device report must allow immediate admin revocation.'
Add-Bullet 'The employee registers the new device and waits for approval.'
Add-Bullet 'Manual attendance remains available as an approval-only fallback; it must be visibly marked unverified by WebAuthn.'
Add-Bullet 'Password changes and suspicious-device events should revoke active sessions; credential revocation is a separate action.'

Add-Heading '11. Privacy and biometric limitations' 1
Add-Para 'WebAuthn does not transmit the employee fingerprint, face template, or device PIN to VE WorkLog. The device uses its local security mechanism to authorize use of the private credential. The server receives a cryptographic assertion and user-verification result.'
Add-Callout 'Important limitation' 'The web application cannot reliably require fingerprint only or Face ID only. With userVerification set to required, the authenticator may use fingerprint, facial recognition, device PIN, screen-lock pattern, computer password, or security-key PIN. The application cannot reliably identify which method was used.' 'FCE8E8'
Add-Para 'If the organization must enforce fingerprint or face recognition without PIN fallback, consider dedicated office biometric hardware or a managed native mobile application with device attestation and specialized face-liveness verification.'

Add-Heading '12. Optional selfie/liveness enhancement' 1
Add-Para 'For stronger deterrence against deliberate device/PIN sharing, add a live camera step after WebAuthn. A plain selfie is an audit aid but can be spoofed with a photograph. Random liveness prompts, such as turning the head or blinking, are stronger but require careful privacy, retention, consent, and false-rejection handling.'
Add-Bullet 'Recommended use: risk-triggered, manual requests, newly replaced devices, or random spot checks rather than necessarily twice every day.'
Add-Bullet 'Store images securely with restricted admin access and a defined deletion/retention period.'
Add-Bullet 'Do not claim that a basic browser selfie provides certified face recognition.'

Add-Heading '13. Application files expected to change' 1
Add-Table @('File','Expected change') @(
  @('package.json','Add @simplewebauthn/server and any selected browser helper/build dependency'),
  @('db/schema.sql','Add credential/challenge tables and attendance audit columns'),
  @('server/routes/webauthn.js','Registration, authentication, device status, replacement, and admin device routes'),
  @('server/routes/attendance.js','Require verified assertion for normal check-in/out; retain approved manual fallback'),
  @('server/index.js','Mount /api/webauthn routes'),
  @('public/app.js','Employee device states, registration ceremony, attendance assertion ceremony, admin approvals'),
  @('public/style.css','Device status, approval list, replacement and verification UI'),
  @('Docker deployment','Rebuild image if package dependencies change; docker cp alone is insufficient for new node_modules')
) @(2.15,4.35) | Out-Null

Add-Heading '14. Implementation phases and estimate' 1
Add-Table @('Phase','Scope','Estimate') @(
  @('1. Foundation','Schema, library, challenge storage, WebAuthn utilities','0.5-1 day'),
  @('2. Registration','Employee registration and admin approval/revoke UI','1 day'),
  @('3. Attendance integration','Secure check-in/out with GPS and audit metadata','1 day'),
  @('4. Recovery and exceptions','Replacement, manual fallback, notifications, anomaly flags','0.5-1 day'),
  @('5. Cross-device QA','Android, iPhone, Windows; deployment and corrections','1 day')
) @(1.45,3.55,1.50) | Out-Null
Add-Para 'Expected production-ready implementation: approximately 3-5 working days. A basic MVP may be available in about 2 working days, but it should not immediately become the official attendance mechanism without cross-device testing and a controlled pilot.'

Add-Heading '15. Testing matrix' 1
Add-Bullet 'Register and approve a platform credential on Android Chrome.'
Add-Bullet 'Register and approve a platform credential on iPhone Safari.'
Add-Bullet 'Register and approve Windows Hello on Windows Chrome/Edge if desktop attendance is supported.'
Add-Bullet 'Attempt attendance from another phone using the correct portal password; expect block.'
Add-Bullet 'Attempt with expired, reused, wrong-purpose, and wrong-user challenges; expect block.'
Add-Bullet 'Attempt with a rejected or revoked credential; expect block.'
Add-Bullet 'Test GPS inside radius, outside radius, permission denied, low accuracy, and malformed coordinates.'
Add-Bullet 'Test before 7:00 AM, present, late, and half-day boundaries in PKT.'
Add-Bullet 'Test checkout while manual check-in approval remains pending.'
Add-Bullet 'Test replacement workflow and ensure old credential can no longer authorize attendance after revocation.'
Add-Bullet 'Confirm employee and admin audit displays clearly distinguish WebAuthn, manual, and admin override events.'
Add-Bullet 'Confirm synchronized-passkey behavior on supported ecosystems and document policy implications.'

Add-Heading '16. Acceptance criteria' 1
Add-Bullet 'Normal check-in/out cannot complete without an approved, non-revoked credential and required user verification.'
Add-Bullet 'Server validates challenge, origin, RP ID, credential ownership, status, verification result, and GPS independently of the browser UI.'
Add-Bullet 'Challenges are short-lived, single-use, purpose-bound, and replay resistant.'
Add-Bullet 'Only admins can approve, reject, revoke, or replace an employee approved attendance credential.'
Add-Bullet 'One-active-credential policy is enforced transactionally.'
Add-Bullet 'Manual attendance remains possible but requires reason, is marked unverified, and follows admin approval.'
Add-Bullet 'No biometric template, fingerprint, Face ID data, or device PIN is stored by VE WorkLog.'
Add-Bullet 'Employee Attendance navigation is restored only when testing resumes and is updated in both empViews and empItems.'
Add-Bullet 'All existing attendance calculations and admin reports continue to work.'

Add-Heading '17. Recommended rollout decision' 1
Add-Number 'Implement registration and admin approval first without enforcing it on attendance.'
Add-Number 'Pilot with a small group using Android, iPhone, and Windows where relevant.'
Add-Number 'Review synchronized-passkey behavior and decide whether one credential or one managed physical device is the actual policy.'
Add-Number 'Enable WebAuthn enforcement for pilot employees while retaining manual approval fallback.'
Add-Number 'Restore the employee Attendance tab when formal testing resumes.'
Add-Number 'After stable operation, enforce WebAuthn for all attendance-enabled employees.'
Add-Number 'Add selfie/liveness only if residual deliberate-collusion risk justifies the privacy and operational burden.'

Add-Heading '18. Final implementation guidance for another AI/developer' 1
Add-Callout 'Do not weaken these controls' 'Never trust a client-provided biometric-success flag, client-provided office-distance result, or client-generated attendance status. Verify WebAuthn and calculate GPS distance/time classification on the server. Keep secrets and SMTP/JWT configuration outside source control.' 'FFF4D6'
Add-Bullet 'Inspect the current GitHub/project state before editing because the attendance module already contains several post-MVP corrections.'
Add-Bullet 'Preserve the separate checkin_remark and checkout_remark fields and distinct Manual Request versus Early Leave / Remote labels.'
Add-Bullet 'Preserve the ability to checkout while check-in approval is pending.'
Add-Bullet 'Preserve company grouping for VTX, VSN, and ALL in daily/monthly/PDF reports.'
Add-Bullet 'Preserve local/PKT date handling; avoid using UTC toISOString() for browser TODAY date selection.'
Add-Bullet 'Rebuild the Docker app image when adding Node dependencies. The production service is vv_app, PostgreSQL is vv_db, and Nginx is vv_nginx.'
Add-Bullet 'The production environment file is /home/ubuntu/vertex-monitoring-app/.env and must not be committed.'
Add-Bullet 'Deploy through the Ubuntu host repository and Docker Compose/container workflow, then verify logs and all WebAuthn ceremonies on the production HTTPS origin.'

Add-Heading '19. Reference standards' 1
Add-Para 'Primary references for implementation: W3C Web Authentication Level 3 specification and the SimpleWebAuthn server/browser documentation. Confirm the installed package version and follow that version API because credential object property names may differ between library releases.'
Add-Bullet 'W3C WebAuthn: https://www.w3.org/TR/webauthn-3/'
Add-Bullet 'SimpleWebAuthn documentation: https://simplewebauthn.dev/docs/'
Add-Bullet 'MDN Web Authentication API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API'

# Save and export PDF for QA
$doc.BuiltInDocumentProperties.Item('Title').Value='WebAuthn-Secured Attendance for VE WorkLog'
$doc.BuiltInDocumentProperties.Item('Subject').Value='Technical development handoff'
$doc.BuiltInDocumentProperties.Item('Author').Value='Vertex Electronics'
$doc.SaveAs2($outputPath,16)
$doc.ExportAsFixedFormat($pdfPath,17)
$doc.Close()
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
Write-Output $outputPath
Write-Output $pdfPath
