# Google Identity enrollment configuration

Create an OAuth 2.0 Client ID of type Web application in Google Cloud Console. Add the exact PWA origin (production: https://flow.muidsoft.com) to Authorized JavaScript origins. Do not create or ship a client secret for GIS.

Set the same public client ID in Cloudflare Worker variable GOOGLE_CLIENT_ID and PWA build variable VITE_GOOGLE_CLIENT_ID. Apply migration 0007 with npx wrangler d1 migrations apply google-flow-auto --remote.

From Android Chrome, select a slot, tap Hubungkan akun Google, then use Google's sign-in button. The Worker validates RS256 signature using Google's JWKS, issuer, audience, expiry, issued-at, verified email and single-use nonce. Challenge TTL is five minutes.

D1 stores Google subject, verified email, verification time and hashed nonce only. Raw ID token is transient and not logged or persisted. No password, access/refresh token, cookie, or Chrome profile is collected.

Identity linking does not set accounts.status=ready and does not authenticate Google Flow. The owner can open Flow manually in Android Chrome. The PWA cannot inspect or transfer that Chrome session to Playwright.
