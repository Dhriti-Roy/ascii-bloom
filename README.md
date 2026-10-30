# Ascii Bloom

Flowers made of code, and shared gardens for people who are far apart.

## Files

```
index.html        the whole front end
api/garden.js     serverless API (Vercel + Turso)
package.json
.gitignore
README.md
```

`garden.js` must stay inside a folder named `api`.

## Deploy (about 10 minutes)

### 1. Make the database (Turso, free: 5 GB)
1. Go to https://turso.tech and sign up (GitHub login works).
2. In the dashboard, create a database named `ascii-bloom`. Pick the region closest to you.
3. Open the database and copy its **URL** (starts with `libsql://`).
4. Create a **token** for it (read and write access, no expiry) and copy it.

### 2. Put the code on GitHub
Upload every file in this folder to a repository, keeping the `api` folder.

### 3. Deploy on Vercel
1. https://vercel.com → **Add New → Project** → import the repository. Leave the build settings alone.
2. Before deploying (or later in **Settings → Environment Variables**), add:
   - `TURSO_DATABASE_URL` = the URL from step 1
   - `TURSO_AUTH_TOKEN` = the token from step 1
   Tick Production, Preview and Development.
3. Deploy. If you added the variables after deploying, open **Deployments → ⋯ → Redeploy**.

### 4. Check it works
Open `https://YOUR-SITE.vercel.app/api/garden?id=test`.
- `{"error":"Garden not found"}` means the API and database are connected.
- A message saying the database is not connected means the two variables are missing or misspelled. Fix and redeploy.

Tables are created automatically on the first request. There is no SQL to run.

## How gardens work

- The garden page always opens. Until it is saved online, flowers are kept in the visitor's browser.
- **Plant your garden** (bottom of the page) saves it online with everything already planted, and gives two links.
- **My Garden link** (`?view=…`) is read-only and shows a "Make your own garden" button.
- **Our Garden link** (`?join=…`) lets anyone holding it plant and remove flowers. Share it only with your person.
- No accounts: whoever holds the Our Garden link has full control. Browsers remember it on each device.
- Stored: garden name, anniversary date, and each flower (type, colour, position, note, a random per-device id, time). No names or emails.
- Limits: 80 flowers per garden, 80-character notes, validated input.
- New flowers appear for the other person within about 6 seconds.
