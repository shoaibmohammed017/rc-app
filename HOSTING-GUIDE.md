# Going Live — Hosting Guide (for non-technical owners)

Goal: turn the app into a **real website with a link** that you and your staff log
into from any phone or computer, with data synced live in the cloud.

**Cost:** ₹0 — everything below uses free plans that are plenty for your business.
**Your time:** ~15–20 minutes (just creating 2 accounts + copying 2 keys).
**Everything technical (database, code, security) → I do it.**

We use two free services:
1. **Supabase** — the secure cloud database + the login system.
2. **Netlify** — puts the app online at a web link.

---

## PART A — Things only YOU can do

### Step 1: Create the database (Supabase)
1. Go to **https://supabase.com** → click **Start your project** → sign up
   (use your Google account / the email `inventory.bharathcyclehub@gmail.com`).
2. Click **New project**.
   - **Name:** `rc-business`
   - **Database Password:** click *Generate*, then **save it somewhere safe**
     (you rarely need it, but don't lose it).
   - **Region:** choose **South Asia (Mumbai)** — fastest for India.
   - Click **Create new project** and wait ~2 minutes while it sets up.
3. Now get the 2 keys I need:
   - In the left menu click the **gear icon (Project Settings)** → **API**.
   - Copy these two values:
     - **Project URL** (looks like `https://abcd1234.supabase.co`)
     - **anon public** key (a long text string under "Project API keys")
   - 👉 These are the two things you send me. The "anon" key is **safe to share** —
     it only works together with the security rules I set up.

### Step 2: Create the hosting account (Netlify)
1. Go to **https://www.netlify.com** → **Sign up** (Google or email).
2. That's it for now — just having the account is enough. I'll either:
   - deploy it for you by **drag-and-dropping** the app folder into Netlify, or
   - walk you through the 3-click drag-and-drop yourself (takes 1 minute).

### Step 3: Send me the keys
Paste these back to me in the chat:
```
SUPABASE URL:  <paste Project URL here>
SUPABASE ANON KEY:  <paste anon public key here>
```
Also tell me the **staff logins** you want, like:
```
Bharath  | owner@email.com   | admin
Ravi     | ravi@email.com    | staff
```

---

## PART B — What I do after you send the keys
1. Give you **one SQL script** to paste into Supabase (1 click) — this builds all the
   tables (sales, purchases, expenses, inventory, etc.) and the **security rules** so
   each staff member only sees your business data.
2. Rewrite the app to **save to the cloud** instead of this browser (so it syncs across
   all devices in real time).
3. Add the **login system** using Supabase Auth (real, secure passwords + password reset).
4. Create your staff login accounts.
5. Add **GST + printable invoices** (if you want them — recommended for India).
6. Deploy to Netlify and hand you the **live link** — installable as an app on every phone.

---

## FAQ
- **Is my data safe?** Yes — it lives in your own Supabase project, with security rules
  so only your logged-in staff can read/write your data.
- **Will I lose what I've entered so far?** No — anything already in the app can be
  exported (Backup button) and we can import it into the cloud version.
- **Is it really free?** Yes for your size. Supabase free tier = 500MB database + 50,000
  users; Netlify free tier = plenty of traffic. A custom domain (like `bharathrc.in`)
  is the only optional paid extra (~₹800/year).
- **Do I need to know coding?** No. You only create the 2 accounts and copy 2 keys.
