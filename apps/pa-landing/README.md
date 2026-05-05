# pa-landing — Claire CTA landing page

iter33 spec collapse 2026-05-05 (Adam directive: "我们可以做一个 pa.wekruit.com,
只需要现在 mvp 就是点击一个页面跳转到 iMessage 就行").

Single static page. No build step. Hosting target binds to Firebase site
`wekruit-pa-landing` (default URL: https://wekruit-pa-landing.web.app).

## Deploy

```bash
firebase deploy --only hosting:pa-landing --project wekruit-5f89b
```

## Custom domain (pa.wekruit.com)

Adam's step. Firebase Console:

1. https://console.firebase.google.com/project/wekruit-5f89b/hosting/sites
2. Select `wekruit-pa-landing` site
3. Add custom domain → `pa.wekruit.com`
4. Firebase shows TXT verification record + A records — add to DNS provider
   (likely Cloudflare for wekruit.com)
5. Wait for SSL provisioning (~15–60 min)

## Future (out of scope for MVP)

- Multi-number support — currently hardcoded to `+13054507715` (SENDBLUE_FROM_NUMBER).
  Will need server-rendered HTML or an API endpoint that returns the right
  number per region / cohort. Adam directive 2026-05-05: "目前先不考虑".
- Analytics — `sessionStorage` breadcrumb stub in place; wire to whatever
  analytics stack we settle on.
- A/B test CTA copy via flag-driven variants.
