# Privacy Policy — CollegeInsight Autofill Extension

**Last updated:** March 15, 2026

## What This Extension Does

CollegeInsight Autofill helps students fill college application forms by pulling data from their CollegeInsight.ai profile. It does NOT submit forms — it only pre-fills fields for the student to review.

## Data Collection

### What we access

- **Your CollegeInsight profile data** (name, academics, activities, essays) — only when you click "Fill This Page"
- **The current page URL** — to detect which portal you're on (Common App, UC Application, etc.)
- **Form field labels and structure** — to match fields to your profile data

### What we do NOT access

- Portal login credentials (passwords)
- Financial data (income, assets, tax information)
- Browser history or other tabs
- Files on your computer

### What we store locally

- Your CollegeInsight authentication token (in Chrome extension storage, encrypted by Chrome)
- Cumulative fill statistics (fields filled count, sessions count)

### What we send to servers

- Your profile data requests go to `api.collegeinsight.ai` (your existing CI account)
- Anonymous telemetry events (which portals are being filled, success rates) — no personal data included

## Data Sharing

We do NOT sell, share, or transfer your data to third parties. All data stays between your browser and CollegeInsight.ai servers.

## Permissions Explained

| Permission  | Why                                                  |
| ----------- | ---------------------------------------------------- |
| `storage`   | Store your CI auth token and fill statistics locally |
| `activeTab` | Detect which portal page you're currently viewing    |

## Contact

Questions about this privacy policy? Email privacy@collegeinsight.ai.
