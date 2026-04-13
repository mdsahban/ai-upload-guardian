# AI Upload Guardian (Public Releases)

Protect sensitive data before it is sent to GenAI tools.

This repository is the **public distribution channel** for extension releases only.
Source code is maintained in a private repository.

## What This Tool Does

AI Upload Guardian helps teams safely use AI tools by:

- scanning file uploads and chat messages for sensitive data,
- routing risky content through admin approval,
- supporting AutoFix sanitization before final submission,
- enforcing invite-based onboarding for controlled usage.

Supported web apps:

- ChatGPT (`chat.openai.com`, `chatgpt.com`)
- Gemini (`gemini.google.com`)
- Claude (`claude.ai`)

## Download and Install

1. Open the latest release from the **Releases** page.
2. Download the ZIP asset: `ai-upload-guardian-extension-vX.Y.Z.zip`.
3. Extract the ZIP to a folder on your computer.
4. In Chrome, open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked**.
7. Select the extracted extension folder.

After loading:

1. Click the extension icon.
2. Enter your work email + invite code.
3. Click **Connect**.

You must complete invite onboarding before upload/chat requests are allowed.

## Updating to a New Version

When a new release is published:

1. Download the newest ZIP from Releases.
2. Extract it to your extension folder (replace old files).
3. Open `chrome://extensions`.
4. Click **Reload** on AI Upload Guardian.

## Admin Panel

Admins manage users, invites, approvals, and audit logs through the web admin panel.
Contact your internal admin for access.

## Security and Privacy Notes

- Invite-based access is required.
- Requests are tracked for governance and audit.
- Admins can approve, block, or sanitize requests.
- Do not share invite codes publicly.

## Support

For access issues, onboarding failures, or approval delays, contact your internal AI governance/admin team.
