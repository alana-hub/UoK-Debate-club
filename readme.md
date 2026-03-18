# University Debate Club Platform (Supabase + Static Frontend)

Production-ready static full-stack app using **HTML/CSS/JavaScript** with **Supabase** backend services.

## File Structure

- `index.html` — member dashboard feed + attendance scanner
- `admin.html` — admin management console (non-indexable)
- `discussion.html` — real-time topic chat room
- `style.css` — shared responsive styles
- `main.js` — frontend app logic, validation, Supabase integration, realtime, reporting
- `supabase.sql` — schema, indexes, helper functions, RLS policies
- `robots.txt` — crawler directives
- `sitemap.xml` — public URLs sitemap

## Supabase Setup

1. Create a Supabase project.
2. Run `supabase.sql` in the SQL editor.
3. Enable Email auth provider in **Authentication → Providers**.
4. Create initial admin user in **Authentication → Users** with email/password.
5. Ensure admin profile in `public.users` has `role='admin'` and matching `reg_no`.
6. Members self-register from the member page using **name + email + registration number + password**.

> If email confirmation is enabled in Supabase Auth, members must verify email before first login.

## Frontend Configuration

Set credentials in `main.js`:

```js
const APP_CONFIG = {
  supabaseUrl: 'https://<your-project>.supabase.co',
  supabaseAnonKey: '<your-anon-key>'
};
```

Or define them before `main.js`:

```html
<script>
  window.SUPABASE_URL = 'https://<your-project>.supabase.co';
  window.SUPABASE_ANON_KEY = '<anon-key>';
</script>
```

## Deploying

### Netlify
1. Push repository to GitHub.
2. Create a new site from Git.
3. Build command: *(empty)*.
4. Publish directory: `/`.

### Vercel
1. Import repository.
2. Framework preset: **Other**.
3. Build command: *(none)*.
4. Output directory: `.`

### GitHub Pages
1. Push repository.
2. Configure **Settings → Pages** to publish from root folder.

## Production Best Practices

- Replace placeholder canonical/sitemap URLs with your real HTTPS domain.
- Add security headers at hosting edge (CSP, HSTS, X-Frame-Options, Referrer-Policy).
- Rotate keys and enforce strict admin account policies.
- Monitor Supabase logs and set alerting for auth/DB errors.

## Features

- Role-aware member/admin flows
- QR attendance with token + expiry validation
- Event/member/post management
- Manual attendance fallback
- Realtime discussion chat with moderation
- Attendance reporting + CSV export + certificate eligibility

